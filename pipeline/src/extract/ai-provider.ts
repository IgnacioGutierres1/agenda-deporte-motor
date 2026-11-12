/**
 * Contrato común de los proveedores de IA de la cadena (ver ai-chain.ts).
 */
import type { GeminiJsonRequest } from './gemini.ts';

export interface ProviderAnswer<T> {
  data: T;
  model: string;
}

export interface AiProvider {
  /** Identificador corto para logs y trazabilidad (gemini, groq). */
  readonly name: string;
  /** Nombre para mostrar en los mensajes (Gemini, Groq). */
  readonly label: string;
  /** false si falta la configuración (clave). */
  readonly configured: boolean;
  readonly unavailableReason: string;
  /** Modelo principal (para la caché cuando el proveedor no informa cuál respondió). */
  readonly defaultModel: string;
  /** null si el proveedor puede tomar el pedido; si no, el motivo (PDF sin texto, imágenes sin modelo con visión…). */
  cannotTake(req: GeminiJsonRequest): string | null;
  /** Imágenes por pedido que acepta (0 si no lee imágenes). */
  maxImages(): number;
  generate<T>(req: GeminiJsonRequest): Promise<ProviderAnswer<T>>;
}

/** El proveedor queda fuera por el resto de la corrida (cupo diario agotado, clave inválida, demasiada espera). */
export class ProviderExhaustedError extends Error {
  constructor(message: string, readonly quota = false) {
    super(message);
    this.name = 'ProviderExhaustedError';
  }
}

/** El proveedor no puede responder ESTE pedido (sigue disponible para otros). */
export class ProviderSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderSkipError';
  }
}

/** Error de la API de un proveedor compatible con OpenAI (nunca incluye la clave). */
export class AiApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiApiError';
  }
}

/** La respuesta no es un JSON que cumpla el esquema pedido: no se usa. */
export class AiInvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiInvalidOutputError';
  }
}
