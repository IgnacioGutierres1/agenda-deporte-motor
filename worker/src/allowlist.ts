/**
 * Fuentes oficiales de tiempos en vivo que el proxy puede consultar (solo estos prefijos, solo GET).
 * Provisorio: se reemplaza por PROXY_ALLOWLIST de @dm/shared cuando estén los lectores de cada fuente.
 */
export const PROXY_ALLOWLIST: readonly string[] = [
  'https://api.motogp.pulselive.com/motogp/v1/timing-gateway/',
  'https://eventresults-api.speedhive.com/api/',
];
