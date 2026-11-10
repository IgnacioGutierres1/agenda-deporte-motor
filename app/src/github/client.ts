/**
 * Cliente mínimo de la API REST de GitHub para:
 * - leer y escribir config/series.user.json (API de contenidos: GET para el sha, PUT con base64 UTF-8);
 * - disparar el workflow de actualización (workflow_dispatch).
 * El token es del dueño del repo y vive solo en el dispositivo (localStorage).
 */

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  fetchFn?: typeof fetch;
}

/** Codifica texto UTF-8 en base64 (btoa solo acepta Latin-1). */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function friendlyError(status: number, apiMessage: string | undefined): string {
  switch (status) {
    case 401:
      return 'GitHub rechazó el token (inválido o vencido). Revisalo en Ajustes.';
    case 403:
      return 'El token no tiene permiso para esta acción. Necesita "Contents: Read and write" y "Actions: Read and write" sobre el repo.';
    case 404:
      return 'No encontré el repo, el archivo o el workflow. Revisá "owner/repo" y que el token tenga acceso a ese repo.';
    case 409:
      return 'El archivo cambió en el repo mientras lo editabas. Volvé a intentar.';
    case 422:
      return `GitHub rechazó el pedido: ${apiMessage ?? 'datos inválidos'}.`;
    default:
      return `Error ${status} de GitHub${apiMessage ? `: ${apiMessage}` : ''}.`;
  }
}

export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? ((...args) => fetch(...args));
  }

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${API}${path}`, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('No se pudo conectar con GitHub. ¿Hay conexión?');
    }
    if (res.status === 204) return { status: 204, data: null };
    const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok) throw new GitHubError(friendlyError(res.status, data?.message), res.status);
    return { status: res.status, data };
  }

  /** Lee un archivo de texto del repo. Devuelve null si no existe. */
  async getFile(path: string, ref?: string): Promise<{ sha: string; text: string } | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const { data } = await this.request<{ sha: string; content: string; encoding: string }>(
        'GET',
        `${this.repoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`,
      );
      if (!data) return null;
      return { sha: data.sha, text: decodeBase64Utf8(data.content) };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  /** Crea o reemplaza un archivo con un commit. `sha` es obligatorio si el archivo ya existe. */
  async putFile(path: string, text: string, message: string, sha?: string, branch?: string): Promise<void> {
    await this.request('PUT', `${this.repoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      message,
      content: encodeBase64Utf8(text),
      ...(sha ? { sha } : {}),
      ...(branch ? { branch } : {}),
    });
  }

  /** Dispara el workflow (workflow_dispatch). GitHub responde 204 sin cuerpo. */
  async dispatchWorkflow(workflow = 'update.yml', ref = 'main'): Promise<void> {
    await this.request('POST', `${this.repoPath}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref });
  }
}
