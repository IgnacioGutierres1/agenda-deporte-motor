/**
 * Cadena de IA gratuita: Gemini -> Groq.
 *
 * El plan gratis de Gemini da ~20 pedidos por día y por modelo; cuando se agota (o falta la clave, o
 * Gemini falla), el pedido pasa a Groq, que tiene su propio cupo gratuito. Implementa la misma interfaz
 * `Gemini` que ya usa el resto del pipeline, así que los llamadores no cambian:
 *
 * - Orden fijo: Gemini (con su propio respaldo entre modelos Flash) y después Groq.
 * - Un proveedor que agotó su cupo diario (o tiene la clave mal) no se vuelve a probar en la corrida.
 * - Si un proveedor no puede tomar un pedido (Groq no lee PDF sin texto ni imágenes sin modelo con visión),
 *   se prueba el siguiente; si ninguno puede, el pedido falla como "no disponible" (el dato queda a confirmar).
 * - Un mismo tope de pedidos por corrida para toda la cadena (GEMINI_MAX_CALLS).
 * - Cada respuesta informa proveedor y modelo (onAnswer), para la caché y el `source` del dato.
 * - La búsqueda con Google del descubrimiento sigue siendo solo de Gemini.
 *
 * GitHub Models (que iba a ser el segundo eslabón) se retiró el 30/7/2026; ver README.
 */
import { createLogger, type Logger } from '../core/log.ts';
import { ProviderExhaustedError, ProviderSkipError, type AiProvider, type ProviderAnswer } from './ai-provider.ts';
import {
  GeminiApiError,
  GeminiBudgetError,
  GeminiQuotaError,
  GeminiUnavailableError,
  getGemini,
  MISSING_KEY_MESSAGE,
  readGeminiConfig,
  type AiAnswerInfo,
  type Gemini,
  type GeminiJsonRequest,
  type GeminiSearchResult,
} from './gemini.ts';
import { createGroq } from './openai-compat.ts';

/** El cliente de IA de la corrida: misma interfaz que el de Gemini. */
export type AiClient = Gemini;

/** Adapta el cliente de Gemini (que ya maneja su respaldo entre modelos) al contrato de proveedor. */
export function geminiProvider(gemini: Gemini): AiProvider {
  return {
    name: 'gemini',
    label: 'Gemini',
    configured: gemini.available,
    unavailableReason: gemini.unavailableReason,
    defaultModel: gemini.extractModel,
    cannotTake: () => (gemini.available ? null : gemini.unavailableReason),
    maxImages: () => Number.POSITIVE_INFINITY,
    async generate<T>(req: GeminiJsonRequest): Promise<ProviderAnswer<T>> {
      let model = gemini.extractModel;
      try {
        const data = await gemini.generateJson<T>({ ...req, onAnswer: (a) => (model = a.model) });
        return { data, model };
      } catch (err) {
        if (err instanceof GeminiBudgetError) throw err;
        if (err instanceof GeminiQuotaError) throw new ProviderExhaustedError(err.message, true);
        if (err instanceof GeminiUnavailableError) throw new ProviderExhaustedError(err.message);
        if (err instanceof GeminiApiError && (err.status === 401 || err.status === 403)) {
          throw new ProviderExhaustedError(`clave inválida o sin permiso (HTTP ${err.status})`);
        }
        throw err;
      }
    },
  };
}

export interface AiChainOptions {
  gemini?: Gemini;
  providers?: AiProvider[];
  env?: Record<string, string | undefined>;
  log?: Pick<Logger, 'info' | 'warn'>;
}

export function createAiChain(opts: AiChainOptions = {}): AiClient {
  const env = opts.env ?? process.env;
  const log = opts.log ?? createLogger('ia');
  const gemini = opts.gemini ?? getGemini();
  const providers = opts.providers ?? [geminiProvider(gemini), createGroq({ env, log })];
  const maxCalls = readGeminiConfig(env).maxCalls;

  const configured = providers.filter((p) => p.configured);
  for (const p of providers) {
    if (!p.configured && p.name !== 'gemini') log.info(`${p.label} no está configurado (${p.unavailableReason}): la cadena de IA sigue sin ese respaldo`);
  }
  const available = configured.length > 0;
  // Sin ningún proveedor: el mensaje empieza por el de Gemini (el que la gente conoce) y suma los respaldos.
  const [first, ...rest] = providers;
  const unavailableReason = available
    ? ''
    : `${first?.unavailableReason || MISSING_KEY_MESSAGE}${rest.length ? ` (tampoco hay respaldo: ${rest.map((p) => p.unavailableReason.replace(/^Falta /, 'falta ')).join(', ')})` : ''}`;

  /** Proveedores fuera por el resto de la corrida, con el motivo. */
  const down = new Map<string, { reason: string; quota: boolean }>();
  let calls = 0;
  let searches = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  }

  async function generateJson<T>(req: GeminiJsonRequest): Promise<T> {
    if (!available) throw new GeminiUnavailableError(unavailableReason);
    if (calls + searches >= maxCalls) throw new GeminiBudgetError(maxCalls);
    calls++;
    const label = req.label ?? 'pedido';
    const reasons: string[] = [];
    let lastError: Error | null = null;
    for (const p of configured) {
      const out = down.get(p.name);
      if (out) {
        reasons.push(`${p.label}: ${out.reason}`);
        continue;
      }
      const why = p.cannotTake(req);
      if (why) {
        reasons.push(`${p.label}: ${why}`);
        continue;
      }
      try {
        const answer = await p.generate<T>(req);
        log.info(`IA: ${label} respondido por ${p.label} (${answer.model})`);
        req.onAnswer?.({ provider: p.name, model: answer.model } satisfies AiAnswerInfo);
        return answer.data;
      } catch (err) {
        if (err instanceof GeminiBudgetError) throw err;
        if (err instanceof ProviderExhaustedError) {
          down.set(p.name, { reason: err.message, quota: err.quota });
          reasons.push(`${p.label}: ${err.message}`);
          log.warn(`${p.label} queda fuera de la cadena de IA por el resto de la corrida: ${err.message}`);
          continue;
        }
        if (err instanceof ProviderSkipError) {
          reasons.push(`${p.label}: ${err.message}`);
          continue;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`${p.label} falló (${label}): ${lastError.message}`);
      }
    }
    if (lastError) throw lastError;
    // Nadie respondió y nadie llegó a fallar de verdad: el pedido no cuenta para el tope.
    calls--;
    const detail = reasons.join('; ');
    const quota = configured.some((p) => down.get(p.name)?.quota);
    if (quota && configured.every((p) => down.has(p.name))) {
      throw new GeminiQuotaError([], `Se agotó el cupo diario gratuito de IA (${detail}); se reintenta en la próxima corrida`);
    }
    throw new GeminiUnavailableError(`IA no disponible para este pedido (${detail})`);
  }

  return {
    available,
    unavailableReason,
    get extractModel() {
      const first = configured.find((p) => !down.has(p.name)) ?? configured[0] ?? providers[0];
      return first?.defaultModel ?? '';
    },
    searchModel: gemini.searchModel,
    callsMade: () => calls + searches,
    maxImagesPerRequest() {
      const live = configured.filter((p) => !down.has(p.name) && p.maxImages() > 0);
      return live[0]?.maxImages() ?? Number.POSITIVE_INFINITY;
    },
    generateJson<T>(req: GeminiJsonRequest): Promise<T> {
      return enqueue(() => generateJson<T>(req));
    },
    searchGrounded(prompt: string): Promise<GeminiSearchResult> {
      // Búsqueda con Google: solo Gemini la tiene (y cuenta para el mismo tope de pedidos).
      if (!gemini.available) return Promise.reject(new GeminiUnavailableError(gemini.unavailableReason));
      if (calls + searches >= maxCalls) return Promise.reject(new GeminiBudgetError(maxCalls));
      searches++;
      return gemini.searchGrounded(prompt);
    },
  };
}

let shared: AiClient | null = null;

/** Cliente de IA compartido por toda la corrida (comparte el cliente de Gemini y el tope de pedidos). */
export function getAi(): AiClient {
  shared ??= createAiChain();
  return shared;
}
