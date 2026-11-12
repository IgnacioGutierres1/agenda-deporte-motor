/** Acceso a localStorage tolerante a errores (modo privado, almacenamiento bloqueado). */

const PREFIX = 'dm:';

export function readJsonStorage<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento: la preferencia dura hasta cerrar la app */
  }
}

interface PersistableStore {
  $id: string;
  $state: object;
  $patch(partial: Record<string, unknown>): void;
  $subscribe(cb: () => void, opts?: { detached?: boolean }): unknown;
}

/**
 * Restaura los campos indicados de un store de Pinia desde localStorage y los guarda en cada cambio.
 * `migrate` adapta lo guardado por versiones anteriores antes de aplicarlo.
 */
export function persistStore(
  store: PersistableStore,
  fields: string[],
  migrate?: (saved: Record<string, unknown>) => Record<string, unknown>,
): void {
  const raw = readJsonStorage<Record<string, unknown>>(store.$id);
  const saved = raw && migrate ? migrate(raw) : raw;
  if (saved) {
    const patch: Record<string, unknown> = {};
    for (const f of fields) if (f in saved) patch[f] = saved[f];
    store.$patch(patch);
  }
  store.$subscribe(
    () => {
      const state = store.$state as Record<string, unknown>;
      const snapshot: Record<string, unknown> = {};
      for (const f of fields) snapshot[f] = state[f];
      writeJsonStorage(store.$id, snapshot);
    },
    { detached: true },
  );
}
