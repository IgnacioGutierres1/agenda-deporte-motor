/**
 * Enlaces de transmisión para la interfaz ("dónde verlo").
 *
 * La tabla nombre → URL, con la fecha en que se verificó cada enlace, está en shared/src/broadcast.ts: también
 * la usa el generador de .ics del pipeline, que no puede importar desde la app. Acá queda lo que es de la
 * interfaz: los canales de una sesión listos para mostrar.
 */
import { broadcastLink, type BroadcastLink } from '@dm/shared';

export { BROADCAST_LINKS_VERIFIED_AT, broadcastKey, broadcastLink, type BroadcastLink } from '@dm/shared';

export interface BroadcastItem {
  name: string;
  /** null: no hay un enlace confirmado y el canal se muestra como texto. */
  link: BroadcastLink | null;
}

/** Canales de una sesión con su enlace, sin nombres vacíos ni repetidos. */
export function broadcastItems(names: string[], seriesName?: string): BroadcastItem[] {
  const seen = new Set<string>();
  const items: BroadcastItem[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({ name, link: broadcastLink(name, seriesName) });
  }
  return items;
}
