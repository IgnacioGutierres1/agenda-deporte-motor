/**
 * Proveedor de IA con API compatible con OpenAI (chat/completions). Hoy: Groq, el respaldo gratuito de Gemini.
 *
 * - Salida JSON: "structured outputs" estricto (json_schema) en los modelos que lo admiten; en el resto,
 *   modo JSON con el esquema en el prompt. En los dos casos la respuesta se controla contra el esquema
 *   (conformToSchema) y una salida inválida se descarta: nunca se acepta un JSON a medias.
 * - No lee PDF: recibe el texto que el pipeline ya extrajo del PDF (GeminiJsonRequest.pdfText).
 * - Imágenes: solo a los modelos con visión, y con tope de imágenes por pedido.
 * - Documentos largos: el plan gratis tiene ~8 mil tokens por minuto, que es también el tope práctico de un
 *   pedido; el texto se recorta a las partes relevantes (condenseText) y, si igual la API responde 413
 *   ("request too large"), se achica más y se reintenta.
 * - Límites: 429 por minuto -> espera corta (la que indica la API) y reintento, con un tope de espera total
 *   por corrida para no colgar el job de CI; 429 por día -> ese modelo no se vuelve a usar en la corrida.
 *
 * La clave viaja en el header Authorization y nunca se escribe en logs ni en mensajes de error.
 */
import type { Logger } from '../core/log.ts';
import { AiApiError, AiInvalidOutputError, ProviderExhaustedError, ProviderSkipError, type AiProvider, type ProviderAnswer } from './ai-provider.ts';
import { CHARS_PER_TOKEN, condenseText, estimateTokens } from './condense.ts';
import { parseLooseJson, type GeminiJsonRequest } from './gemini.ts';
import { conformToSchema, toJsonSchema } from './json-schema.ts';

export interface OpenAiCompatConfig {
  name: string;
  label: string;
  url: string;
  apiKey?: string;
  missingKeyMessage: string;
  /** Modelos de texto, en orden de preferencia (cada uno tiene su propio cupo). */
  models: string[];
  /** Modelos con visión (para imágenes), en orden de preferencia. */
  visionModels: string[];
  maxImages: number;
  maxImageBytes: number;
  /** Tope estimado de tokens de entrada por pedido (instrucciones + documento + esquema). */
  maxInputTokens: number;
  /** Tope de tokens de salida por pedido (incluye el razonamiento de los modelos que razonan). */
  maxOutputTokens: number;
  /** Pausa mínima entre pedidos (ms). */
  delayMs: number;
  /** Reintentos ante 429 por minuto o 5xx, por modelo y pedido. */
  retries: number;
  /** Espera total máxima por límites de pedidos en la corrida (ms); pasado eso, el proveedor queda fuera. */
  maxWaitMs: number;
}

export interface OpenAiCompatOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Pick<Logger, 'info' | 'warn'>;
}

/** Tokens que ocupa una imagen en los modelos con visión de Groq. */
const TOKENS_PER_IMAGE = 2048;
/** Una espera indicada más larga que esto no es un límite por minuto: el modelo queda fuera en la corrida. */
const LONG_WAIT_MS = 120_000;
/** Achiques del documento ante un 413 ("request too large"), por modelo y pedido. */
const MAX_SHRINKS = 2;

/** Modelos que admiten structured outputs estricto (json_schema con strict: true) según la doc de Groq. */
const STRICT_RE = /^(openai\/gpt-oss-(20b|120b)|qwen\/qwen3|meta-models\/muse-spark)/;

/** Parámetros de razonamiento: razonar poco (gasta tokens del cupo por minuto) y no devolver el razonamiento. */
function reasoningParams(model: string): Record<string, unknown> {
  if (/gpt-oss/.test(model)) return { reasoning_effort: 'low', include_reasoning: false };
  if (/qwen3/.test(model)) return { reasoning_format: 'hidden' };
  return {};
}

export function createOpenAiCompatProvider(cfg: OpenAiCompatConfig, opts: OpenAiCompatOptions = {}): AiProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log;
  const configured = !!cfg.apiKey;

  /** Modelos fuera por el resto de la corrida (cupo diario, retirados, caídos). */
  const exhausted = new Set<string>();
  /** Modelos que rechazaron json_schema: se usa modo JSON con el esquema en el prompt. */
  const jsonObjectOnly = new Set<string>();
  /** Hasta cuándo esperar antes de volver a usar cada modelo (límite por minuto). */
  const coolingUntil = new Map<string, number>();
  let lastCallAt = 0;
  let waited = 0;

  function textOf(req: GeminiJsonRequest): string | undefined {
    return req.pdf ? (req.pdfText ?? req.text) : req.text;
  }

  function cannotTake(req: GeminiJsonRequest): string | null {
    if (!configured) return cfg.missingKeyMessage;
    const n = req.images?.length ?? 0;
    if (n > 0) {
      if (cfg.visionModels.length === 0) return 'no hay modelo con visión configurado';
      if (n > cfg.maxImages) return `${n} imágenes en un pedido (acepta hasta ${cfg.maxImages})`;
      if (req.images!.some((i) => i.data.length > cfg.maxImageBytes)) return 'una imagen supera el tamaño que acepta';
    }
    if (req.pdf && !textOf(req)?.trim()) return 'no lee PDF y no hay texto extraído del PDF';
    return null;
  }

  function buildBody(req: GeminiJsonRequest, model: string, shrink: number): { body: unknown; condensed: { from: number; to: number } | null } {
    const strict = STRICT_RE.test(model) && !jsonObjectOnly.has(model);
    const schemaJson = JSON.stringify(toJsonSchema(req.schema, strict));
    const jsonRule = strict
      ? 'Respondé solo con el JSON pedido.'
      : `Respondé SOLO con un objeto JSON válido (sin texto adicional ni bloques de código) que cumpla este JSON Schema:\n${schemaJson}`;
    const system = [req.system, jsonRule].filter(Boolean).join('\n\n');
    const images = req.images ?? [];
    // Presupuesto del documento: lo que queda del tope de entrada después de instrucciones, esquema e imágenes.
    const fixed = estimateTokens(system + req.prompt + schemaJson) + images.length * TOKENS_PER_IMAGE + 100;
    const maxChars = Math.max(2000, Math.floor((cfg.maxInputTokens * shrink - fixed) * CHARS_PER_TOKEN));
    let docText = textOf(req);
    let condensed: { from: number; to: number } | null = null;
    if (docText && docText.length > maxChars) {
      const short = condenseText(docText, maxChars, req.focus);
      condensed = { from: docText.length, to: short.length };
      docText = short;
    }
    const header = condensed
      ? 'DOCUMENTO OFICIAL (extracto: el documento completo es más largo; [...] marca las partes omitidas):'
      : 'DOCUMENTO OFICIAL:';
    const userText = [docText ? `${header}\n"""\n${docText}\n"""` : '', req.prompt].filter(Boolean).join('\n\n');
    const content = images.length
      ? [
          { type: 'text', text: userText },
          ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${Buffer.from(i.data).toString('base64')}` } })),
        ]
      : userText;
    const body = {
      model,
      temperature: 0,
      max_completion_tokens: cfg.maxOutputTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format: strict
        ? { type: 'json_schema', json_schema: { name: 'respuesta', strict: true, schema: toJsonSchema(req.schema, true) } }
        : { type: 'json_object' },
      ...reasoningParams(model),
    };
    return { body, condensed };
  }

  function parseOutput<T>(req: GeminiJsonRequest, model: string, res: ChatResponse): T {
    const choice = res.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'length') {
      throw new AiInvalidOutputError(`${cfg.label} (${model}) cortó la respuesta por el tope de tokens de salida`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = parseLooseJson(content);
    }
    if (parsed === null || parsed === undefined) throw new AiInvalidOutputError(`${cfg.label} (${model}) devolvió un JSON inválido`);
    const r = conformToSchema(parsed, req.schema);
    if (r.error) throw new AiInvalidOutputError(`${cfg.label} (${model}) devolvió un JSON que no cumple el esquema (${r.error})`);
    return r.value as T;
  }

  async function wait(ms: number, countsAsLimit: boolean): Promise<void> {
    if (ms <= 0) return;
    if (countsAsLimit) {
      if (waited + ms > cfg.maxWaitMs) {
        throw new ProviderExhaustedError(
          `se superó la espera máxima por límites de pedidos (${Math.round(cfg.maxWaitMs / 1000)} s en la corrida)`,
        );
      }
      waited += ms;
    }
    await sleep(ms);
  }

  async function generate<T>(req: GeminiJsonRequest): Promise<ProviderAnswer<T>> {
    const why = cannotTake(req);
    if (why) throw new ProviderSkipError(why);
    const wanted = req.images?.length ? cfg.visionModels : cfg.models;
    const models = [...new Set(req.model && wanted.includes(req.model) ? [req.model, ...wanted] : wanted)];
    /** Modelos que ya no se prueban para ESTE pedido. */
    const done = new Set<string>();
    const attempts = new Map<string, number>();
    const shrinks = new Map<string, number>();
    let lastError: Error | null = null;
    const label = req.label ?? 'pedido';

    for (;;) {
      const candidates = models.filter((m) => !exhausted.has(m) && !done.has(m));
      if (candidates.length === 0) break;
      // El primero que no esté esperando por el límite por minuto; si todos esperan, el que se libera antes.
      const t0 = now();
      const model = candidates.find((m) => (coolingUntil.get(m) ?? 0) <= t0)
        ?? candidates.reduce((a, b) => ((coolingUntil.get(a) ?? 0) <= (coolingUntil.get(b) ?? 0) ? a : b));
      await wait((coolingUntil.get(model) ?? 0) - t0, true);
      await wait(lastCallAt + cfg.delayMs - now(), false);
      lastCallAt = now();

      const shrink = 0.85 ** (shrinks.get(model) ?? 0);
      const { body, condensed } = buildBody(req, model, shrink);
      if (condensed) {
        log?.info(`${cfg.label} (${model}): ${label}: documento recortado de ${condensed.from} a ${condensed.to} caracteres (partes relevantes)`);
      }
      const attempt = (attempts.get(model) ?? 0) + 1;
      attempts.set(model, attempt);

      let res: Response;
      try {
        res = await doFetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        lastError = new AiApiError(0, `${cfg.label} no respondió (${model}): ${err instanceof Error ? err.message : String(err)}`);
        if (attempt > cfg.retries) exhausted.add(model);
        else coolingUntil.set(model, now() + backoffMs(attempt));
        continue;
      }

      if (res.ok) {
        try {
          const data = parseOutput<T>(req, model, (await res.json()) as ChatResponse);
          return { data, model };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          log?.warn(`${lastError.message}; se prueba con otro modelo`);
          done.add(model);
          continue;
        }
      }

      const detail = await readError(res);
      const msg = `${cfg.label} respondió HTTP ${res.status} (${model}): ${detail.message}`;
      if (res.status === 401 || res.status === 403) {
        throw new ProviderExhaustedError(`clave inválida o sin permiso (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        const hint = detail.retryAfterMs ?? retryAfterHeader(res);
        if (detail.daily || (hint !== null && hint > LONG_WAIT_MS)) {
          // Cupo diario (o una espera de minutos): este modelo no se vuelve a usar hoy.
          log?.warn(`${msg}; ${model} queda fuera por el resto de la corrida`);
          exhausted.add(model);
          lastError = new AiApiError(429, msg);
          continue;
        }
        lastError = new AiApiError(429, msg);
        if (attempt > cfg.retries) done.add(model);
        else coolingUntil.set(model, now() + Math.max(hint ?? 0, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      if (res.status === 413) {
        // Pedido más grande que el límite por minuto: se achica el documento y se reintenta.
        lastError = new AiApiError(413, msg);
        const n = shrinks.get(model) ?? 0;
        if (n < MAX_SHRINKS && (textOf(req)?.length ?? 0) > 2000) {
          shrinks.set(model, n + 1 + (detail.tooLargeRatio && detail.tooLargeRatio > 1.4 ? 1 : 0));
          attempts.set(model, attempt - 1);
        } else {
          done.add(model);
        }
        continue;
      }
      if (res.status === 400 && /response_format|json_schema|structured/i.test(detail.message) && /support/i.test(detail.message) && !jsonObjectOnly.has(model)) {
        // El modelo no admite json_schema: modo JSON con el esquema en el prompt (y control posterior).
        jsonObjectOnly.add(model);
        attempts.set(model, attempt - 1);
        continue;
      }
      if (res.status === 400 && detail.code === 'json_validate_failed') {
        lastError = new AiInvalidOutputError(`${cfg.label} (${model}) no pudo generar un JSON válido`);
        log?.warn(`${lastError.message}; se prueba con otro modelo`);
        done.add(model);
        continue;
      }
      if (res.status === 404) {
        // Modelo retirado o inexistente: no se vuelve a usar en la corrida.
        log?.warn(`${msg}; ${model} queda fuera por el resto de la corrida`);
        exhausted.add(model);
        lastError = new AiApiError(404, msg);
        continue;
      }
      if (res.status >= 500) {
        lastError = new AiApiError(res.status, msg);
        if (attempt > cfg.retries) exhausted.add(model);
        else coolingUntil.set(model, now() + backoffMs(attempt));
        continue;
      }
      lastError = new AiApiError(res.status, msg);
      done.add(model);
    }

    if (cfg.models.every((m) => exhausted.has(m))) {
      throw new ProviderExhaustedError(`no le queda ningún modelo disponible hoy (${cfg.models.join(', ')})`, true);
    }
    if (lastError instanceof AiApiError && lastError.status === 429) {
      // Límite por minuto que no se liberó a tiempo: transitorio, el dato queda para la próxima corrida.
      throw new ProviderSkipError(lastError.message);
    }
    if (lastError) throw lastError;
    throw new ProviderSkipError('ningún modelo disponible para este pedido');
  }

  return {
    name: cfg.name,
    label: cfg.label,
    configured,
    unavailableReason: configured ? '' : cfg.missingKeyMessage,
    defaultModel: cfg.models[0] ?? '',
    cannotTake,
    maxImages: () => (cfg.visionModels.some((m) => !exhausted.has(m)) ? cfg.maxImages : 0),
    generate,
  };
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
}

async function readError(res: Response): Promise<{ message: string; code?: string; daily: boolean; retryAfterMs: number | null; tooLargeRatio: number | null }> {
  let message = res.statusText;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } | string; message?: string };
    const err = typeof body.error === 'string' ? { message: body.error } : body.error;
    message = (err?.message ?? body.message ?? res.statusText).split('\n')[0]!.slice(0, 300);
    code = err?.code;
  } catch {
    /* cuerpo vacío o no JSON */
  }
  // Groq: "... on requests per day (RPD): Limit 1000, Used 1000 ... Please try again in 1m26.4s."
  const daily = res.status === 429 && /per day|\b(RPD|TPD)\b/i.test(message);
  const m = message.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i);
  const limits = message.match(/Limit\s+(\d+),\s*Requested\s+(\d+)/i);
  return {
    message,
    ...(code ? { code } : {}),
    daily,
    retryAfterMs: m ? parseDuration(m[1]!) : null,
    tooLargeRatio: limits ? Number(limits[2]) / Number(limits[1]) : null,
  };
}

/** "1m26.4s" | "7.66s" | "450ms" | "2h3m" -> ms. */
export function parseDuration(text: string): number | null {
  let ms = 0;
  let any = false;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    any = true;
    const v = Number(n);
    ms += unit === 'h' ? v * 3_600_000 : unit === 'm' ? v * 60_000 : unit === 's' ? v * 1000 : v;
  }
  return any ? Math.ceil(ms) : null;
}

function retryAfterHeader(res: Response): number | null {
  const v = res.headers.get('retry-after');
  const secs = v ? Number(v) : NaN;
  return Number.isFinite(secs) ? secs * 1000 : null;
}

function backoffMs(attempt: number): number {
  return Math.min(5000 * 3 ** (attempt - 1), 60_000); // 5 s, 15 s, 45 s
}

// ─── Groq ─────────────────────────────────────────────────────────────────────────────────────

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
/**
 * gpt-oss-120b: modelo de producción de Groq con structured outputs estricto; plan gratis ~1000 pedidos/día
 * y 30/min (pero ~8 mil tokens/min). Los de respaldo tienen su propio cupo.
 */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GROQ_FALLBACK_MODELS = ['openai/gpt-oss-20b'];
/** Único modelo con visión del catálogo de Groq hoy (preview; hasta 3 imágenes por pedido, JSON estricto). */
export const DEFAULT_GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';

export function readGroqConfig(env: Record<string, string | undefined> = process.env): OpenAiCompatConfig {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  // Vacío = la lista por defecto; "none" = sin modelos de respaldo.
  const list = (v: string | undefined, d: string[]) =>
    v !== undefined && v.trim() !== '' ? v.split(',').map((m) => m.trim()).filter((m) => m && m !== 'none') : d;
  const model = env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  // Vacío = el de siempre (Actions pasa las variables no definidas como ''); "none" = sin visión.
  const vision = env.GROQ_VISION_MODEL?.trim() || DEFAULT_GROQ_VISION_MODEL;
  return {
    name: 'groq',
    label: 'Groq',
    url: GROQ_URL,
    apiKey: env.GROQ_API_KEY?.trim() || undefined,
    missingKeyMessage: 'Falta GROQ_API_KEY',
    models: [...new Set([model, ...list(env.GROQ_FALLBACK_MODELS, DEFAULT_GROQ_FALLBACK_MODELS)])],
    visionModels: vision && vision !== 'none' ? [vision] : [],
    // La doc admite 3 imágenes por pedido, pero cada una son ~2 mil tokens del cupo por minuto.
    maxImages: num(env.GROQ_VISION_MAX_IMAGES, 2),
    // Las imágenes viajan en base64 dentro del pedido (Groq limita el tamaño de un pedido con imágenes en base64).
    maxImageBytes: 3_000_000,
    maxInputTokens: num(env.GROQ_MAX_INPUT_TOKENS, 5000),
    maxOutputTokens: num(env.GROQ_MAX_OUTPUT_TOKENS, 3000),
    delayMs: num(env.GROQ_DELAY_MS, 2500),
    retries: num(env.GROQ_RETRIES, 3),
    maxWaitMs: num(env.GROQ_MAX_WAIT_S, 480) * 1000,
  };
}

export function createGroq(opts: OpenAiCompatOptions & { env?: Record<string, string | undefined> } = {}): AiProvider {
  return createOpenAiCompatProvider(readGroqConfig(opts.env ?? process.env), opts);
}
