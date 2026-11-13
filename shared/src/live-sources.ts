/**
 * De dónde sale el "En vivo" de cada categoría: página oficial de tiempos (siempre) y, cuando hay
 * una fuente JSON utilizable, qué pedir, cada cuánto y si hace falta pasar por el proxy (Worker).
 *
 * Verificado el 2026-11-10 (ver docs/en-vivo.md). Las URLs oficiales respondieron 200; varias son
 * aplicaciones de una sola página que responden 200 a cualquier ruta, así que conviene revisarlas
 * a mano si cambian de temporada.
 */
import type { LiveProvider } from './live.ts';

export interface SpeedhiveSelector {
  /** Organizaciones de Speedhive que suben los resultados (cronometradores). */
  orgIds: number[];
  /** Filtro sobre el nombre del evento ("TC2000 - FECHA #10"). */
  eventPattern: RegExp;
  /** Filtro sobre el nombre del grupo/categoría dentro del evento ("TC2000", "TN CLASE 2"). */
  groupPattern: RegExp;
  /** false = la categoría sube resultados de forma irregular (no siempre aparecen). */
  reliable: boolean;
}

export interface LiveSource {
  /** Página oficial de tiempos ("Ver tiempos oficiales"). */
  officialUrl: string;
  /** Aclaración sobre el enlace (pago, sólo resultados, etc.). */
  officialNote?: string;
  provider?: LiveProvider;
  /** NASCAR: valor de `series_id` en live-feed.json (1 Cup, 2 O'Reilly/Xfinity, 3 Truck). */
  nascarSeriesId?: number;
  /** MotoGP: valor de `head.category` en livetiming-lite. */
  motogpCategory?: string;
  /** Speedhive: cómo encontrar la última sesión publicada (resultados, no vivo). */
  speedhive?: SpeedhiveSelector;
}

export const NASCAR_LIVE_FEED_URL = 'https://cf.nascar.com/live/feeds/live-feed.json';
export const MOTOGP_LIVE_URL = 'https://api.motogp.pulselive.com/motogp/v1/timing-gateway/livetiming-lite';
export const SPEEDHIVE_API = 'https://eventresults-api.speedhive.com/api/v0.2.3/eventresults';

/** Organizaciones de Speedhive (eventresults) verificadas. */
export const SPEEDHIVE_ORGS = {
  /** REALTIME GROUP SRL (Quilmes): TC2000, Top Race, Fórmula Nacional, TCR South America. */
  realtime: 318672,
  /** "Tiempos crono" (Buenos Aires): APAT TN, APTP Turismo Pista, ACTC regionales, zonales. */
  tiemposCrono: 381036,
  /** ACTC (cuenta propia): sube algunos eventos de TC/TC Pista/TC Mouras/TC Pick Up, irregular. */
  actc: 265199,
} as const;

const NASCAR_LEADERBOARD = 'https://www.nascar.com/leaderboard';
const MOTOGP_TIMING = 'https://timingpass.motogp.com/en/';
const MOTOGP_NOTE = 'TimingPass es pago; la tabla de la app sale del widget gratuito de motogp.com.';
const ACTC_SPEEDHIVE = [SPEEDHIVE_ORGS.actc, SPEEDHIVE_ORGS.tiemposCrono];
const ACTC_EVENT = /ACTC|TURISMO CARRETERA|\bTC\b|MOURAS|PICK ?UP/i;
const ACTC_NOTE = 'ACTC tiene tiempos en vivo propios (Socket.IO, con autorización): sólo enlace.';

function srov(site: string): LiveSource {
  return { officialUrl: `https://www.${site}/watch-live#live-timing`, officialNote: 'El widget de tiempos aparece sólo el fin de semana de carrera.' };
}

export const LIVE_SOURCES: Record<string, LiveSource> = {
  f1: { officialUrl: 'https://www.formula1.com/en/timing/f1-live', officialNote: 'Tiempos completos requieren F1 TV / app oficial.' },
  f2: { officialUrl: 'https://www.fiaformula2.com/livetiming/index.html' },
  f3: { officialUrl: 'https://www.fiaformula3.com/livetiming/index.html' },
  'porsche-supercup': { officialUrl: 'https://racing.porsche.com/mobil-1-supercup/live-timing' },
  'f1-academy': { officialUrl: 'https://www.f1academy.com/livetiming/index.html' },
  motogp: { officialUrl: MOTOGP_TIMING, officialNote: MOTOGP_NOTE, provider: 'motogp', motogpCategory: 'MotoGP' },
  moto2: { officialUrl: MOTOGP_TIMING, officialNote: MOTOGP_NOTE, provider: 'motogp', motogpCategory: 'Moto2' },
  moto3: { officialUrl: MOTOGP_TIMING, officialNote: MOTOGP_NOTE, provider: 'motogp', motogpCategory: 'Moto3' },
  indycar: { officialUrl: 'https://www.indycar.com/leaderboard' },
  'indy-nxt': { officialUrl: 'https://www.indynxt.com/leaderboard' },
  'nascar-cup': { officialUrl: NASCAR_LEADERBOARD, provider: 'nascar', nascarSeriesId: 1 },
  'nascar-xfinity': { officialUrl: NASCAR_LEADERBOARD, provider: 'nascar', nascarSeriesId: 2 },
  'nascar-truck': { officialUrl: NASCAR_LEADERBOARD, provider: 'nascar', nascarSeriesId: 3 },
  'gtwc-europe': srov('gt-world-challenge-europe.com'),
  'gtwc-asia': srov('gt-world-challenge-asia.com'),
  'gtwc-america': srov('gt-world-challenge-america.com'),
  'gtwc-australia': srov('gt-world-challenge-australia.com'),
  igtc: srov('intercontinentalgtchallenge.com'),
  dtm: { officialUrl: 'https://www.dtm.com/en/livetiming' },
  nls: { officialUrl: 'https://www.nuerburgring-langstrecken-serie.de/live/' },
  imsa: { officialUrl: 'https://www.imsa.com/leaderboard', officialNote: 'Protegido contra bots; abre bien en el navegador.' },
  wec: { officialUrl: 'https://plus.fiawec.com/en', officialNote: 'Tiempos en FIAWEC+ (puede pedir cuenta).' },
  elms: { officialUrl: 'https://plus.fiawec.com/en/european-le-mans-series', officialNote: 'Tiempos en FIAWEC+ (puede pedir cuenta).' },
  alms: { officialUrl: 'https://plus.fiawec.com/en/asian-le-mans-series', officialNote: 'Tiempos en FIAWEC+ (puede pedir cuenta).' },
  'super-gt': { officialUrl: 'https://supergt.net/en/', officialNote: 'Sin página pública de tiempos en vivo: resultados en el sitio oficial.' },
  'super-formula': { officialUrl: 'https://superformula.net/sf3/live_timing/' },
  'super-taikyu': { officialUrl: 'https://www.supertaikyu.live/timings/' },
  'macau-gp': { officialUrl: 'https://www.macau.grandprix.gov.mo/en/info/schedule', officialNote: 'Sin página pública de tiempos en vivo: programa y resultados en el sitio oficial.' },
  supercars: { officialUrl: 'https://www.supercars.com/live-timing' },
  '24h-series': { officialUrl: 'https://livetiming.getraceresults.com/24hseries' },
  'gt-open': { officialUrl: 'https://gtopen.gtsport.es/resultados', officialNote: 'Sin tiempos en vivo públicos: resultados.' },
  wrc: { officialUrl: 'https://www.wrc.com/live-timing', officialNote: 'Live Centre oficial: lleva a los tiempos del rally en curso o del último corrido.' },
  dakar: { officialUrl: 'https://www.dakar.com/es/clasificaciones', officialNote: 'Clasificación de cada etapa y general en el sitio oficial.' },
  tc: {
    officialUrl: 'https://tiempos.actc.org.ar/live/tc',
    officialNote: ACTC_NOTE,
    provider: 'speedhive',
    speedhive: { orgIds: ACTC_SPEEDHIVE, eventPattern: ACTC_EVENT, groupPattern: /^\s*(TC|TURISMO CARRETERA)\s*$/i, reliable: false },
  },
  'tc-pista': {
    officialUrl: 'https://tiempos.actc.org.ar/live/tcp',
    officialNote: ACTC_NOTE,
    provider: 'speedhive',
    speedhive: { orgIds: ACTC_SPEEDHIVE, eventPattern: ACTC_EVENT, groupPattern: /^\s*TC PISTA\s*$/i, reliable: false },
  },
  'tc-pickup': {
    officialUrl: 'https://tiempos.actc.org.ar/live/tcpk',
    officialNote: ACTC_NOTE,
    provider: 'speedhive',
    speedhive: { orgIds: ACTC_SPEEDHIVE, eventPattern: ACTC_EVENT, groupPattern: /^\s*TC PICK ?UP\s*$/i, reliable: false },
  },
  'tc-mouras': {
    officialUrl: 'https://tiempos.actc.org.ar/live/tcm',
    officialNote: ACTC_NOTE,
    provider: 'speedhive',
    speedhive: { orgIds: ACTC_SPEEDHIVE, eventPattern: ACTC_EVENT, groupPattern: /^\s*TC MOURAS\s*$/i, reliable: false },
  },
  tn: {
    officialUrl: 'https://apat.org.ar/carreras',
    officialNote: 'APAT no publica tiempos en vivo; resultados por sesión.',
    provider: 'speedhive',
    speedhive: { orgIds: [SPEEDHIVE_ORGS.tiemposCrono], eventPattern: /\bAPAT\b|\bTN\b/i, groupPattern: /^\s*TN CLASE [23]\s*$/i, reliable: true },
  },
  tc2000: {
    officialUrl: 'https://speedhive.mylaps.com/livetiming/YLNSNDLQ-2147484293',
    officialNote: 'Enlace "Tiempos Online" de tc2000.com.ar (Speedhive).',
    provider: 'speedhive',
    speedhive: { orgIds: [SPEEDHIVE_ORGS.realtime], eventPattern: /TC ?2000/i, groupPattern: /^\s*TC ?2000\s*$/i, reliable: true },
  },
  'turismo-pista': {
    officialUrl: 'https://aptpweb.com.ar/resultados-clase-1/',
    officialNote: 'APTP no publica tiempos en vivo; resultados por sesión.',
    provider: 'speedhive',
    speedhive: { orgIds: [SPEEDHIVE_ORGS.tiemposCrono], eventPattern: /\bAPTP\b/i, groupPattern: /^\s*TP CLASE [123]\s*$/i, reliable: true },
  },
};

export function liveSource(seriesId: string): LiveSource | undefined {
  return LIVE_SOURCES[seriesId];
}

/** Qué pedir para una categoría. */
export interface LiveUpstream {
  provider: LiveProvider;
  /**
   * - 'board': JSON que va directo al lector (parseNascarLive / parseMotogpLive).
   * - 'speedhive-org-events': primer paso de Speedhive; seguir con pickSpeedhiveEvents ->
   *   speedhiveEventUrl -> pickSpeedhiveSessions -> speedhiveClassificationUrl -> parseSpeedhiveClassification.
   */
  kind: 'board' | 'speedhive-org-events';
  url: string;
  /** true = el navegador no puede pedirlo directo (CORS): pasar por el Worker. */
  viaProxy: boolean;
  /** Intervalo de consulta recomendado, en segundos. */
  pollSeconds: number;
}

/** Intervalos recomendados (segundos). El Worker debería además cachear unos segundos. */
export const LIVE_POLL_SECONDS: Record<LiveProvider, number> = {
  nascar: 10,
  motogp: 15,
  speedhive: 120,
};

export function speedhiveOrgEventsUrl(orgId: number, count = 10): string {
  return `${SPEEDHIVE_API}/organizations/${orgId}/events?count=${count}`;
}
export function speedhiveEventUrl(eventId: number | string): string {
  return `${SPEEDHIVE_API}/events/${eventId}?sessions=true`;
}
export function speedhiveClassificationUrl(sessionId: number | string): string {
  return `${SPEEDHIVE_API}/sessions/${sessionId}/classification`;
}
/** Página pública de resultados de una sesión en Speedhive. */
export function speedhiveSessionPageUrl(sessionId: number | string): string {
  return `https://speedhive.mylaps.com/sessions/${sessionId}`;
}

/** URL(s) a consultar para una categoría; [] si no hay fuente JSON (sólo enlace oficial). */
export function liveUpstreams(seriesId: string): LiveUpstream[] {
  const src = LIVE_SOURCES[seriesId];
  if (!src?.provider) return [];
  switch (src.provider) {
    case 'nascar':
      // CORS abierto (Access-Control-Allow-Origin: *). Un único feed para todas las divisiones:
      // filtrar por series_id (parseNascarLive lo informa como seriesId).
      return [{ provider: 'nascar', kind: 'board', url: NASCAR_LIVE_FEED_URL, viaProxy: false, pollSeconds: LIVE_POLL_SECONDS.nascar }];
    case 'motogp':
      // Rechaza pedidos con cabecera Origin (403 "Invalid CORS request"): proxy.
      return [{ provider: 'motogp', kind: 'board', url: MOTOGP_LIVE_URL, viaProxy: true, pollSeconds: LIVE_POLL_SECONDS.motogp }];
    case 'speedhive':
      return (src.speedhive?.orgIds ?? []).map((id) => ({
        provider: 'speedhive' as const,
        kind: 'speedhive-org-events' as const,
        url: speedhiveOrgEventsUrl(id),
        viaProxy: true,
        pollSeconds: LIVE_POLL_SECONDS.speedhive,
      }));
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const speedhiveOrgIds = [...new Set(Object.values(LIVE_SOURCES).flatMap((s) => s.speedhive?.orgIds ?? []))].sort((a, b) => a - b);

/**
 * URLs que el Worker debe aceptar (y nada más). Sólo GET. NASCAR no figura porque tiene CORS abierto.
 */
export const PROXY_ALLOWLIST: readonly RegExp[] = [
  new RegExp(`^${esc(MOTOGP_LIVE_URL)}$`),
  new RegExp(`^${esc(SPEEDHIVE_API)}/organizations/(?:${speedhiveOrgIds.join('|')})/events\\?count=\\d{1,2}$`),
  new RegExp(`^${esc(SPEEDHIVE_API)}/events/\\d{1,10}\\?sessions=true$`),
  new RegExp(`^${esc(SPEEDHIVE_API)}/sessions/\\d{1,12}/classification$`),
];

export function isProxyAllowed(url: string): boolean {
  return PROXY_ALLOWLIST.some((re) => re.test(url));
}
