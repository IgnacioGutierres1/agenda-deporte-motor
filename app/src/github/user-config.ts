/**
 * Edición de config/series.user.json desde la app (categorías compartidas por todos los que usan la app).
 * Las funciones de cambio son puras; `commitUserConfig` valida con el esquema compartido antes de escribir.
 */
import { slugify, userSeriesConfigSchema, type SeriesGroup, type UserSeriesConfig } from '@dm/shared';
import type { GitHubClient } from './client.ts';

export const USER_CONFIG_PATH = 'config/series.user.json';
export const WORKFLOW_FILE = 'update.yml';
export const WORKFLOW_REF = 'main';

export const EMPTY_USER_CONFIG: UserSeriesConfig = { added: [], disabled: [], pinned: [], hidden: [] };

export interface UserConfigChange {
  config: UserSeriesConfig;
  /** Mensaje de commit (en español). */
  message: string;
}

export interface NewSeriesInput {
  name: string;
  url?: string;
  group?: SeriesGroup;
}

const clone = (c: UserSeriesConfig): UserSeriesConfig => JSON.parse(JSON.stringify(c)) as UserSeriesConfig;
const without = (list: string[], id: string) => list.filter((x) => x !== id);

export function addSeries(config: UserSeriesConfig, input: NewSeriesInput, existingIds: string[] = []): UserConfigChange {
  const name = input.name.trim();
  if (!name) throw new Error('Poné el nombre de la categoría.');
  const id = slugify(name);
  if (!id) throw new Error('El nombre tiene que tener letras o números.');
  if (existingIds.includes(id) || config.added.some((a) => a.id === id)) {
    throw new Error(`Ya existe una categoría con el id "${id}".`);
  }
  const url = input.url?.trim();
  if (url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      throw new Error('La URL oficial no es válida (tiene que empezar con https://).');
    }
  }
  const next = clone(config);
  next.added.push({
    id,
    name,
    shortName: name,
    officialUrls: url ? [url] : [],
    group: input.group ?? 'otros',
    strategy: 'generic',
    enabled: true,
  });
  next.disabled = without(next.disabled, id);
  next.hidden = without(next.hidden, id);
  return { config: next, message: `config: agregar categoría "${name}" desde la app` };
}

export function removeAddedSeries(config: UserSeriesConfig, id: string, name = id): UserConfigChange {
  const next = clone(config);
  next.added = next.added.filter((a) => a.id !== id);
  return { config: next, message: `config: quitar categoría "${name}" desde la app` };
}

export function setSeriesDisabled(config: UserSeriesConfig, id: string, disabled: boolean, name = id): UserConfigChange {
  const next = clone(config);
  next.disabled = without(next.disabled, id);
  if (disabled) next.disabled.push(id);
  return {
    config: next,
    message: disabled ? `config: desactivar "${name}" desde la app` : `config: reactivar "${name}" desde la app`,
  };
}

export function pinDiscovered(config: UserSeriesConfig, id: string, name = id): UserConfigChange {
  const next = clone(config);
  next.hidden = without(next.hidden, id);
  if (!next.pinned.includes(id)) next.pinned.push(id);
  return { config: next, message: `config: fijar competencia descubierta "${name}"` };
}

export function hideDiscovered(config: UserSeriesConfig, id: string, name = id): UserConfigChange {
  const next = clone(config);
  next.pinned = without(next.pinned, id);
  if (!next.hidden.includes(id)) next.hidden.push(id);
  return { config: next, message: `config: ocultar competencia descubierta "${name}"` };
}

export function unhideDiscovered(config: UserSeriesConfig, id: string, name = id): UserConfigChange {
  const next = clone(config);
  next.hidden = without(next.hidden, id);
  return { config: next, message: `config: volver a mostrar "${name}"` };
}

export function parseUserConfig(text: string): UserSeriesConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${USER_CONFIG_PATH} no es un JSON válido.`);
  }
  const parsed = userSeriesConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${USER_CONFIG_PATH} no cumple el formato esperado.`);
  return parsed.data as UserSeriesConfig;
}

export async function readUserConfig(client: GitHubClient): Promise<{ config: UserSeriesConfig; sha?: string }> {
  const file = await client.getFile(USER_CONFIG_PATH, WORKFLOW_REF);
  if (!file) return { config: clone(EMPTY_USER_CONFIG) };
  return { config: parseUserConfig(file.text), sha: file.sha };
}

/**
 * Lee la configuración actual (para tener el sha y no pisar cambios), aplica el cambio, valida,
 * hace el commit y dispara el workflow de actualización.
 */
export async function commitUserConfig(
  client: GitHubClient,
  change: (current: UserSeriesConfig) => UserConfigChange,
): Promise<{ config: UserSeriesConfig; workflowTriggered: boolean; workflowError?: string }> {
  const { config: current, sha } = await readUserConfig(client);
  const { config, message } = change(current);
  const valid = userSeriesConfigSchema.safeParse(config);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    throw new Error(`El cambio no es válido (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}).`);
  }
  const text = `${JSON.stringify(config, null, 2)}\n`;
  await client.putFile(USER_CONFIG_PATH, text, message, sha, WORKFLOW_REF);
  try {
    await client.dispatchWorkflow(WORKFLOW_FILE, WORKFLOW_REF);
    return { config, workflowTriggered: true };
  } catch (e) {
    return { config, workflowTriggered: false, workflowError: (e as Error).message };
  }
}
