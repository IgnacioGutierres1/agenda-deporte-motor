/**
 * Cliente mínimo de la API de Gemini (REST con fetch, sin SDK).
 *
 * - Salida JSON estructurada (responseMimeType + responseSchema), temperatura 0.
 * - Entrada: texto plano, PDF inline (base64) y/o imágenes inline (en alta resolución).
 * - Llamadas en serie con una pausa entre ellas, reintentos con espera ante 429/500/503
 *   y tope de llamadas por corrida (GEMINI_MAX_CALLS).
 * - Búsqueda de Google (grounding) solo para el descubrimiento.
 * - Cupo diario: el plan gratuito da un cupo de pedidos por día POR MODELO (hoy 20). Cuando un modelo
 *   lo agota (429 con cuota "PerDay") se pasa al siguiente de la lista sin esperar (GEMINI_FALLBACK_MODELS).
 * - Proveedor: AI Studio (clave de API, por defecto) o Vertex AI (proyecto + token de acceso),
 *   por si el crédito mensual de Google AI Pro solo se aplica vía Vertex.
 *
 * La clave nunca se escribe en logs ni en mensajes de error (viaja en un header, no en la URL).
 */

/** Esquema de respuesta (subconjunto OpenAPI que aceptan AI Studio y Vertex). */
export interface GeminiSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN';
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  propertyOrdering?: string[];
}

export interface GeminiJsonRequest {
  /** Instrucciones (en el rol de sistema). */
  system?: string;
  prompt: string;
  schema: GeminiSchema;
  /** Texto del documento oficial. */
  text?: string;
  /** PDF del documento oficial (se envía inline). */
  pdf?: Uint8Array;
  /** Imágenes oficiales (se envían inline, en alta resolución para leer tablas chicas). */
  images?: Array<{ mimeType: string; data: Uint8Array }>;
  model?: string;
  /** Etiqueta para los logs (nunca incluye datos sensibles). */
  label?: string;
}

export interface GroundingSource {
  url: string;
  title: string;
}

export interface GeminiSearchResult {
  text: string;
  sources: GroundingSource[];
}

export interface Gemini {
  /** false si falta la configuración (clave o proyecto/token). */
  readonly available: boolean;
  /** Mensaje para el usuario cuando no está disponible. */
  readonly unavailableReason: string;
  readonly extractModel: string;
  readonly searchModel: string;
  generateJson<T>(req: GeminiJsonRequest): Promise<T>;
  /** Consulta con búsqueda de Google. Solo la usa el descubrimiento. */
  searchGrounded(prompt: string): Promise<GeminiSearchResult>;
  /** Llamadas lógicas hechas en esta corrida (sin contar reintentos). */
  callsMade(): number;
}

export const MISSING_KEY_MESSAGE = 'Falta GEMINI_API_KEY';

/** Modelo por defecto para transcribir documentos (plan gratuito, Flash estable). */
export const DEFAULT_EXTRACT_MODEL = 'gemini-3.6-flash';
/**
 * Modelo por defecto para búsqueda con Google: 2.5 Flash-Lite comparte con 2.5 Flash
 * el cupo gratuito de búsqueda (500/día) y no figura como retirado. En Gemini 3+ la búsqueda es paga.
 */
/**
 * Modelos de respaldo para transcribir cuando el principal agota su cupo diario gratuito
 * (cada modelo tiene su propio cupo). Se pueden cambiar con GEMINI_FALLBACK_MODELS (separados por coma).
 */
export const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

export const DEFAULT_SEARCH_MODEL = 'gemini-2.5-flash-lite';

export class GeminiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

/** Todos los modelos agotaron su cupo diario gratuito: los datos que dependen de IA quedan para la próxima corrida. */
export class GeminiQuotaError extends GeminiUnavailableError {
  constructor(models: string[]) {
    super(`Se agotó el cupo diario gratuito de Gemini (modelos: ${models.join(', ')}); se reintenta en la próxima corrida`);
    this.name = 'GeminiQuotaError';
  }
}

export class GeminiBudgetError extends Error {
  constructor(max: number) {
    super(`Se alcanzó el tope de ${max} llamadas a Gemini en esta corrida (GEMINI_MAX_CALLS)`);
    this.name = 'GeminiBudgetError';
  }
}

export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** true si es un 429 por cupo diario agotado (no tiene sentido reintentar con ese modelo hoy). */
    public readonly dailyQuota = false,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

export interface GeminiOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface GeminiConfig {
  provider: 'aistudio' | 'vertex';
  apiKey?: string;
  project?: string;
  location: string;
  accessToken?: string;
  extractModel: string;
  fallbackModels: string[];
  searchModel: string;
  maxCalls: number;
  delayMs: number;
  retries: number;
}

export function readGeminiConfig(env: Record<string, string | undefined> = process.env): GeminiConfig {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    provider: env.GEMINI_PROVIDER?.toLowerCase() === 'vertex' ? 'vertex' : 'aistudio',
    apiKey: env.GEMINI_API_KEY?.trim() || undefined,
    project: env.GOOGLE_CLOUD_PROJECT?.trim() || undefined,
    location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
    accessToken: env.GOOGLE_ACCESS_TOKEN?.trim() || undefined,
    extractModel: env.GEMINI_MODEL?.trim() || DEFAULT_EXTRACT_MODEL,
    fallbackModels: env.GEMINI_FALLBACK_MODELS !== undefined && env.GEMINI_FALLBACK_MODELS.trim() !== ''
      ? env.GEMINI_FALLBACK_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
      : DEFAULT_FALLBACK_MODELS,
    searchModel: env.GEMINI_SEARCH_MODEL?.trim() || DEFAULT_SEARCH_MODEL,
    maxCalls: num(env.GEMINI_MAX_CALLS, 60),
    delayMs: num(env.GEMINI_DELAY_MS, 4000),
    retries: num(env.GEMINI_RETRIES, 3),
  };
}

export function createGemini(opts: GeminiOptions = {}): Gemini {
  const cfg = readGeminiConfig(opts.env ?? process.env);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let unavailableReason = '';
  if (cfg.provider === 'aistudio' && !cfg.apiKey) unavailableReason = MISSING_KEY_MESSAGE;
  if (cfg.provider === 'vertex' && (!cfg.project || !cfg.accessToken)) {
    unavailableReason = 'Faltan GOOGLE_CLOUD_PROJECT y/o GOOGLE_ACCESS_TOKEN (GEMINI_PROVIDER=vertex)';
  }
  const available = !unavailableReason;

  let calls = 0;
  let lastCallAt = 0;
  // Cola: una llamada por vez en todo el proceso.
  let queue: Promise<unknown> = Promise.resolve();

  function endpoint(model: string): { url: string; headers: Record<string, string> } {
    if (cfg.provider === 'vertex') {
      const host = cfg.location === 'global' ? 'aiplatform.googleapis.com' : `${cfg.location}-aiplatform.googleapis.com`;
      return {
        url: `https://${host}/v1/projects/${cfg.project}/locations/${cfg.location}/publishers/google/models/${model}:generateContent`,
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
      };
    }
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'x-goog-api-key': cfg.apiKey! },
    };
  }

  async function call(model: string, body: unknown): Promise<GenerateResponse> {
    if (!available) throw new GeminiUnavailableError(unavailableReason);
    if (calls >= cfg.maxCalls) throw new GeminiBudgetError(cfg.maxCalls);
    calls++;
    const { url, headers } = endpoint(model);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      const wait = lastCallAt + cfg.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        lastError = new GeminiApiError(0, `Gemini no respondió: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < cfg.retries) await sleep(backoffMs(attempt, null));
        continue;
      }
      if (res.ok) return (await res.json()) as GenerateResponse;
      const detail = await readError(res);
      lastError = new GeminiApiError(res.status, `Gemini respondió HTTP ${res.status} (${model}): ${detail.message}`, detail.daily);
      if (detail.daily) throw lastError; // el cupo diario no se recupera esperando
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
      if (attempt < cfg.retries) await sleep(backoffMs(attempt, detail.retryAfterMs ?? retryAfterHeader(res)));
    }
    throw lastError ?? new GeminiApiError(0, 'Gemini falló');
  }

  /** Modelos que agotaron su cupo diario (o ya no existen) en esta corrida. */
  const exhausted = new Set<string>();

  /** Llama al modelo pedido y, si agotó su cupo diario, a los de respaldo (en orden). */
  async function callWithFallback(model: string, body: unknown): Promise<GenerateResponse> {
    const chain = [model, ...cfg.fallbackModels.filter((m) => m !== model)];
    for (const m of chain) {
      if (exhausted.has(m)) continue;
      try {
        return await call(m, body);
      } catch (err) {
        // Cupo diario agotado, modelo retirado (404) o saturado aun después de los reintentos (5xx):
        // se prueba el siguiente modelo y este no se vuelve a usar en la corrida.
        const skip = err instanceof GeminiApiError && (err.dailyQuota || err.status === 404 || err.status >= 500);
        if (!skip) throw err;
        exhausted.add(m);
        calls--; // el pedido no se hizo: no cuenta para el tope por corrida
      }
    }
    throw new GeminiQuotaError(chain);
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  }

  return {
    available,
    unavailableReason,
    extractModel: cfg.extractModel,
    searchModel: cfg.searchModel,
    callsMade: () => calls,

    generateJson<T>(req: GeminiJsonRequest): Promise<T> {
      return enqueue(async () => {
        const parts: Array<Record<string, unknown>> = [];
        if (req.pdf) {
          parts.push({ inlineData: { mimeType: 'application/pdf', data: Buffer.from(req.pdf).toString('base64') } });
        }
        for (const img of req.images ?? []) {
          parts.push({ inlineData: { mimeType: img.mimeType, data: Buffer.from(img.data).toString('base64') } });
        }
        if (req.text) parts.push({ text: `DOCUMENTO OFICIAL:\n"""\n${req.text}\n"""` });
        parts.push({ text: req.prompt });
        const body = {
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: req.schema,
            ...(req.images?.length ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}),
          },
        };
        const res = await callWithFallback(req.model ?? cfg.extractModel, body);
        const text = responseText(res);
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new GeminiApiError(200, 'Gemini devolvió un JSON inválido');
        }
      });
    },

    searchGrounded(prompt: string): Promise<GeminiSearchResult> {
      return enqueue(async () => {
        const body = {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0 },
        };
        const res = await call(cfg.searchModel, body);
        const text = responseText(res);
        const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const sources = chunks
          .map((c) => ({ url: c.web?.uri ?? '', title: c.web?.title ?? '' }))
          .filter((s) => s.url);
        return { text, sources };
      });
    },
  };
}

interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
}

function responseText(res: GenerateResponse): string {
  if (res.promptFeedback?.blockReason) {
    throw new GeminiApiError(200, `Gemini bloqueó el pedido (${res.promptFeedback.blockReason})`);
  }
  const cand = res.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  if (!text) throw new GeminiApiError(200, `Gemini no devolvió contenido (${cand?.finishReason ?? 'sin candidato'})`);
  return text;
}

async function readError(res: Response): Promise<{ message: string; retryAfterMs: number | null; daily: boolean }> {
  try {
    const body = (await res.json()) as {
      error?: {
        message?: string;
        details?: Array<{ '@type'?: string; retryDelay?: string; violations?: Array<{ quotaId?: string; quotaValue?: string }> }>;
      };
    };
    const delay = body.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const secs = delay ? Number.parseFloat(delay) : NaN;
    // Cuotas superadas (p. ej. "GenerateRequestsPerDayPerProjectPerModel-FreeTier=20"): explican un 429.
    const quotas = (body.error?.details ?? [])
      .flatMap((d) => d.violations ?? [])
      .map((v) => `${v.quotaId ?? '?'}=${v.quotaValue ?? '?'}`);
    const message = (body.error?.message ?? res.statusText).split('\n')[0]!.slice(0, 200);
    return {
      daily: res.status === 429 && quotas.some((q) => /PerDay/i.test(q)),
      message: quotas.length ? `${message} [cuota: ${[...new Set(quotas)].join(', ')}]` : message,
      retryAfterMs: Number.isFinite(secs) ? secs * 1000 : null,
    };
  } catch {
    return { message: res.statusText, retryAfterMs: null, daily: false };
  }
}

function retryAfterHeader(res: Response): number | null {
  const v = res.headers.get('retry-after');
  const secs = v ? Number(v) : NaN;
  return Number.isFinite(secs) ? secs * 1000 : null;
}

function backoffMs(attempt: number, hinted: number | null): number {
  const base = 5000 * 3 ** attempt; // 5 s, 15 s, 45 s
  return Math.min(Math.max(hinted ?? 0, base), 120_000);
}

let shared: Gemini | null = null;

/** Cliente compartido por toda la corrida (el tope de llamadas es global). */
export function getGemini(): Gemini {
  shared ??= createGemini();
  return shared;
}

/** Extrae el primer objeto/array JSON de un texto libre (respuestas con búsqueda, que no admiten esquema). */
export function parseLooseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.search(/[[{]/);
  if (start < 0) return null;
  for (let end = fenced.length; end > start; end--) {
    const c = fenced[end - 1];
    if (c !== '}' && c !== ']') continue;
    try {
      return JSON.parse(fenced.slice(start, end)) as T;
    } catch {
      /* probar un cierre anterior */
    }
  }
  return null;
}
