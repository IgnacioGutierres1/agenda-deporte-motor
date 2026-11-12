import { describe, expect, it } from 'vitest';
import { createAiChain, geminiProvider } from '../src/extract/ai-chain.ts';
import { AiInvalidOutputError } from '../src/extract/ai-provider.ts';
import { condenseText } from '../src/extract/condense.ts';
import {
  createGemini,
  GeminiBudgetError,
  GeminiQuotaError,
  GeminiUnavailableError,
  type AiAnswerInfo,
  type GeminiSchema,
} from '../src/extract/gemini.ts';
import { conformToSchema, toJsonSchema } from '../src/extract/json-schema.ts';
import { createGroq, GROQ_URL, parseDuration } from '../src/extract/openai-compat.ts';
import { sourceSchema } from '@dm/shared';
import { aiStandings, imageDocument, newTrace, traceModel } from '../src/generic/ai.ts';
import type { ExtractionCache } from '../src/generic/cache.ts';
import { fakeGemini, genericSeries } from './fakes.ts';

function memoryCache(): ExtractionCache & { store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    store,
    async get(s, k) {
      return store.get(`${s}|${k}`) ?? null;
    },
    async set(s, k, _h, entry) {
      store.set(`${s}|${k}`, { key: 'x', ...entry });
    },
  };
}

const schema: GeminiSchema = {
  type: 'OBJECT',
  properties: { ok: { type: 'BOOLEAN' }, note: { type: 'STRING' }, n: { type: 'INTEGER', nullable: true } },
  required: ['ok'],
};

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

type Handler = (call: Call) => Response;

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const geminiOk = (payload: unknown) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
const geminiDaily = () =>
  json(
    {
      error: {
        message: 'You exceeded your current quota',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }],
      },
    },
    429,
  );
const groqOk = (content: unknown, finish = 'stop') =>
  json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }] });
const groqLimit = (message: string, retryAfter?: string) =>
  json({ error: { message, type: 'tokens', code: 'rate_limit_exceeded' } }, 429, retryAfter ? { 'retry-after': retryAfter } : {});

/** Reloj falso: sleep avanza el tiempo (así las esperas por límite por minuto se cumplen al instante). */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

function setup(env: Record<string, string>, handler: { gemini?: Handler; groq?: Handler }) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const c = clock();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> };
    calls.push(call);
    if (call.url.startsWith(GROQ_URL)) {
      if (!handler.groq) throw new Error('Groq no debería llamarse');
      return handler.groq(call);
    }
    if (!handler.gemini) throw new Error('Gemini no debería llamarse');
    return handler.gemini(call);
  }) as typeof fetch;
  const fullEnv = { GEMINI_DELAY_MS: '0', GROQ_DELAY_MS: '0', ...env };
  const log = { info: (m: string) => logs.push(`info: ${m}`), warn: (m: string) => logs.push(`warn: ${m}`) };
  const gemini = createGemini({ env: fullEnv, fetchImpl, sleep: c.sleep });
  const groq = createGroq({ env: fullEnv, fetchImpl, sleep: c.sleep, now: c.now, log });
  // La cadena armada a mano con los mismos proveedores que createAiChain, pero con HTTP y reloj falsos.
  const ai = createAiChain({ env: fullEnv, gemini, providers: [geminiProvider(gemini), groq], log });
  return { calls, logs, clock: c, ai };
}

async function chainFor(env: Record<string, string>, handler: { gemini?: Handler; groq?: Handler }) {
  const s = setup(env, handler);
  const groqCalls = () => s.calls.filter((c) => c.url.startsWith(GROQ_URL));
  const geminiCalls = () => s.calls.filter((c) => !c.url.startsWith(GROQ_URL));
  return { ...s, groqCalls, geminiCalls };
}

describe('cadena de IA: orden y cupos', () => {
  it('con Gemini disponible responde Gemini y Groq ni se toca', async () => {
    const answers: AiAnswerInfo[] = [];
    const t = await chainFor({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }, { gemini: () => geminiOk({ ok: true }) });
    await expect(t.ai.generateJson({ prompt: 'x', schema, onAnswer: (a) => answers.push(a) })).resolves.toEqual({ ok: true });
    expect(t.groqCalls()).toHaveLength(0);
    expect(answers).toEqual([{ provider: 'gemini', model: 'gemini-3.6-flash' }]);
    expect(t.logs).toContain('info: IA: pedido respondido por Gemini (gemini-3.6-flash)');
  });

  it('si Gemini agotó el cupo diario de todos sus modelos pasa a Groq, y no lo vuelve a probar en la corrida', async () => {
    const answers: AiAnswerInfo[] = [];
    const t = await chainFor(
      { GEMINI_API_KEY: 'g', GEMINI_MODEL: 'm1', GEMINI_FALLBACK_MODELS: 'm2', GROQ_API_KEY: 'q' },
      { gemini: geminiDaily, groq: () => groqOk({ ok: true, note: null, n: null }) },
    );
    await expect(t.ai.generateJson({ prompt: 'a', schema, onAnswer: (a) => answers.push(a) })).resolves.toEqual({ ok: true, n: null });
    await expect(t.ai.generateJson({ prompt: 'b', schema })).resolves.toEqual({ ok: true, n: null });
    expect(t.geminiCalls()).toHaveLength(2); // m1 y m2, una sola vez
    expect(t.groqCalls()).toHaveLength(2);
    expect(answers).toEqual([{ provider: 'groq', model: 'openai/gpt-oss-120b' }]);
    expect(t.logs.some((l) => l.startsWith('warn: Gemini queda fuera de la cadena'))).toBe(true);
    expect(t.ai.callsMade()).toBe(2);
    // La clave de Groq va en el header, en formato OpenAI, con salida estricta y temperatura 0.
    const call = t.groqCalls()[0]!;
    expect(call.headers.Authorization).toBe('Bearer q');
    expect(call.body.temperature).toBe(0);
    expect(call.body.response_format.type).toBe('json_schema');
    expect(call.body.response_format.json_schema.strict).toBe(true);
    expect(call.body.reasoning_effort).toBe('low');
  });

  it('si Gemini falla con un error (no de cupo), ese pedido lo responde Groq pero Gemini sigue en la cadena', async () => {
    let geminiStatus = 400;
    const t = await chainFor(
      { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' },
      { gemini: () => (geminiStatus === 400 ? json({ error: { message: 'bad' } }, 400) : geminiOk({ ok: false })), groq: () => groqOk({ ok: true, note: 'x', n: 1 }) },
    );
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true, note: 'x', n: 1 });
    geminiStatus = 200;
    await expect(t.ai.generateJson({ prompt: 'b', schema })).resolves.toEqual({ ok: false });
  });

  it('una clave de Gemini inválida (403) saca a Gemini de la corrida', async () => {
    const t = await chainFor(
      { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' },
      { gemini: () => json({ error: { message: 'denied' } }, 403), groq: () => groqOk({ ok: true, note: null, n: null }) },
    );
    await t.ai.generateJson({ prompt: 'a', schema });
    await t.ai.generateJson({ prompt: 'b', schema });
    expect(t.geminiCalls()).toHaveLength(1);
  });

  it('sin GROQ_API_KEY: Groq se omite con un aviso y, agotado Gemini, el pedido queda "no disponible"', async () => {
    const t = await chainFor({ GEMINI_API_KEY: 'g', GEMINI_MODEL: 'm1', GEMINI_FALLBACK_MODELS: 'm2' }, { gemini: geminiDaily });
    expect(t.logs).toContain('info: Groq no está configurado (Falta GROQ_API_KEY): la cadena de IA sigue sin ese respaldo');
    const err = await t.ai.generateJson({ prompt: 'a', schema }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GeminiQuotaError);
    expect(err).toBeInstanceOf(GeminiUnavailableError);
    expect((err as Error).message).toContain('Se agotó el cupo diario gratuito de IA');
    expect(t.groqCalls()).toHaveLength(0);
    expect(t.ai.callsMade()).toBe(0);
  });

  it('sin ninguna clave no está disponible y el mensaje empieza por la clave de Gemini', async () => {
    const t = await chainFor({}, {});
    expect(t.ai.available).toBe(false);
    expect(t.ai.unavailableReason).toBe('Falta GEMINI_API_KEY (tampoco hay respaldo: falta GROQ_API_KEY)');
    await expect(t.ai.generateJson({ prompt: 'a', schema })).rejects.toBeInstanceOf(GeminiUnavailableError);
  });

  it('solo Groq configurado: responde Groq', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => groqOk({ ok: true, note: null, n: null }) });
    expect(t.ai.available).toBe(true);
    expect(t.ai.extractModel).toBe('openai/gpt-oss-120b');
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true, n: null });
  });

  it('el tope de pedidos por corrida (GEMINI_MAX_CALLS) es de toda la cadena', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q', GEMINI_MAX_CALLS: '1' }, { groq: () => groqOk({ ok: true, note: null, n: null }) });
    await t.ai.generateJson({ prompt: 'a', schema });
    await expect(t.ai.generateJson({ prompt: 'b', schema })).rejects.toBeInstanceOf(GeminiBudgetError);
  });
});

describe('Groq: límites', () => {
  it('429 por minuto: espera lo que indica la API y reintenta el mismo modelo', async () => {
    const replies = [groqLimit('Rate limit reached ... on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000. Please try again in 7.5s.'), groqOk({ ok: true })];
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_FALLBACK_MODELS: 'none' }, { groq: () => replies.shift()! });
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true });
    expect(t.groqCalls().map((c) => c.body.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    expect(t.clock.waits).toContain(7500);
  });

  it('429 por minuto con otro modelo libre: usa ese (cada modelo tiene su propio límite) sin esperar', async () => {
    const replies = [groqLimit('Rate limit reached ... (TPM). Please try again in 30s.'), groqOk({ ok: true })];
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => replies.shift()! });
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true });
    expect(t.groqCalls().map((c) => c.body.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    expect(t.clock.waits.filter((w) => w > 0)).toEqual([]);
  });

  it('429 por día: ese modelo queda fuera en la corrida y se usa el de respaldo', async () => {
    const t = await chainFor(
      { GROQ_API_KEY: 'q' },
      {
        groq: (c) =>
          c.body.model === 'openai/gpt-oss-120b'
            ? groqLimit('Rate limit reached ... on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1h2m.')
            : groqOk({ ok: true }),
      },
    );
    await t.ai.generateJson({ prompt: 'a', schema });
    await t.ai.generateJson({ prompt: 'b', schema });
    expect(t.groqCalls().map((c) => c.body.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b']);
    expect(t.clock.waits.filter((w) => w > 0)).toEqual([]);
  });

  it('todos los modelos con cupo diario agotado: Groq queda fuera y el pedido es "no disponible"', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => groqLimit('Rate limit reached on tokens per day (TPD): Limit 200000') });
    const err = await t.ai.generateJson({ prompt: 'a', schema }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GeminiQuotaError);
    expect(t.groqCalls()).toHaveLength(2);
  });

  it('no espera más que el tope por corrida (no cuelga el job de CI)', async () => {
    const t = await chainFor(
      { GROQ_API_KEY: 'q', GROQ_MAX_WAIT_S: '30', GROQ_FALLBACK_MODELS: 'retirado-x', GROQ_RETRIES: '5' },
      { groq: (c) => (c.body.model === 'retirado-x' ? json({ error: { message: 'model not found' } }, 404) : groqLimit('per minute. Please try again in 20s.')) },
    );
    const err = await t.ai.generateJson({ prompt: 'a', schema }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GeminiUnavailableError);
    expect((err as Error).message).toContain('espera máxima');
    expect(t.clock.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  it('413 (pedido más grande que el límite): achica el documento y reintenta', async () => {
    const replies = [json({ error: { message: 'Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9000' } }, 413), groqOk({ ok: true })];
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_MAX_INPUT_TOKENS: '4000' }, { groq: () => replies.shift()! });
    const text = Array.from({ length: 400 }, (_, i) => `Línea ${i} del reglamento con texto de relleno`).join('\n');
    await t.ai.generateJson({ prompt: 'a', schema, text });
    const [first, second] = t.groqCalls().map((c) => String(c.body.messages[1].content).length);
    expect(second!).toBeLessThan(first!);
  });
});

describe('Groq: documentos, PDF e imágenes', () => {
  it('PDF: Groq recibe el texto ya extraído, nunca el binario', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => groqOk({ ok: true }) });
    await t.ai.generateJson({ prompt: 'Transcribí', schema, pdf: new Uint8Array([37, 80, 68, 70]), pdfText: 'Practice 1 09:30' });
    const user = t.groqCalls()[0]!.body.messages[1].content as string;
    expect(user).toContain('DOCUMENTO OFICIAL:\n"""\nPractice 1 09:30\n"""');
    expect(JSON.stringify(t.groqCalls()[0]!.body)).not.toContain('JVBERg');
  });

  it('PDF sin texto: Groq no lo puede tomar y el pedido queda "no disponible"', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, {});
    const err = await t.ai.generateJson({ prompt: 'a', schema, pdf: new Uint8Array([1]) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GeminiUnavailableError);
    expect((err as Error).message).toContain('no lee PDF');
    expect(t.calls).toHaveLength(0);
  });

  it('documento largo: se recorta a las partes que nombran lo buscado y se avisa en el prompt', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_MAX_INPUT_TOKENS: '2000' }, { groq: () => groqOk({ ok: true }) });
    const filler = Array.from({ length: 300 }, (_, i) => `Párrafo ${i} sobre reglamento deportivo general.`).join('\n\n');
    const text = `${filler}\n\nCronograma Copa Rafaela\nSábado 21/11\nClasificación 10:30\n\n${filler}`;
    await t.ai.generateJson({ prompt: 'a', schema, text, focus: ['Copa Rafaela', '21/11'] });
    const user = t.groqCalls()[0]!.body.messages[1].content as string;
    expect(user.length).toBeLessThan(text.length);
    expect(user).toContain('extracto');
    expect(user).toContain('Clasificación 10:30');
    expect(t.logs.some((l) => l.includes('documento recortado'))).toBe(true);
  });

  it('imágenes: solo al modelo con visión, en base64; con más imágenes de las que acepta, "no disponible"', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => groqOk({ ok: true }) });
    const img = { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) };
    await t.ai.generateJson({ prompt: 'a', schema, images: [img] });
    const body = t.groqCalls()[0]!.body;
    expect(body.model).toBe('qwen/qwen3.8-27b');
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });
    expect(t.ai.maxImagesPerRequest!()).toBe(2);
    await expect(t.ai.generateJson({ prompt: 'a', schema, images: [img, img, img] })).rejects.toBeInstanceOf(GeminiUnavailableError);
    expect(t.groqCalls()).toHaveLength(1);
  });

  it('sin modelo con visión (GROQ_VISION_MODEL=none) las imágenes no van a Groq', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_VISION_MODEL: 'none' }, {});
    const err = await t.ai.generateJson({ prompt: 'a', schema, images: [{ mimeType: 'image/png', data: new Uint8Array([1]) }] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GeminiUnavailableError);
    expect((err as Error).message).toContain('visión');
  });

  it('la transcripción de imágenes se manda en tandas cuando responde un proveedor con tope de imágenes', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, {
      groq: (c) => groqOk({ images: c.body.messages[1].content.slice(1).map((_: unknown, i: number) => ({ text: `img ${i}` })) }),
    });
    const cache = memoryCache();
    const store = cache.store;
    const images = [1, 2, 3, 4, 5].map((n) => ({ url: `https://x.org/${n}.png`, mimeType: 'image/png', data: new Uint8Array([n]) }));
    const doc = await imageDocument({ gemini: t.ai, cache }, 'tp', { url: 'https://x.org/', title: 'Calendario' }, images);
    expect(t.groqCalls().map((c) => c.body.messages[1].content.length - 1)).toEqual([2, 2, 1]);
    expect(doc!.text.match(/=== Imagen/g)).toHaveLength(5);
    expect(store.get('tp|image-text').model).toBe('groq/qwen/qwen3.8-27b');
  });
});

describe('Groq: salida JSON', () => {
  it('un JSON inválido o fuera de esquema se descarta y se prueba el modelo de respaldo', async () => {
    const replies = [groqOk('esto no es JSON'), groqOk({ ok: 'sí' })];
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_FALLBACK_MODELS: 'openai/gpt-oss-20b,qwen/qwen3.8-27b' }, { groq: () => replies.shift() ?? groqOk({ ok: true }) });
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true });
    expect(t.groqCalls().map((c) => c.body.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  });

  it('si ningún modelo devuelve un JSON válido, el pedido falla (nunca se acepta a medias)', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => groqOk({ note: 'sin ok' }) });
    const err = await t.ai.generateJson({ prompt: 'a', schema }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AiInvalidOutputError);
    expect((err as Error).message).toContain('no cumple el esquema');
  });

  it('respuesta cortada por el tope de tokens: inválida', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_FALLBACK_MODELS: 'openai/gpt-oss-20b' }, { groq: () => groqOk('{"ok": tr', 'length') });
    await expect(t.ai.generateJson({ prompt: 'a', schema })).rejects.toBeInstanceOf(AiInvalidOutputError);
  });

  it('un modelo sin json_schema estricto usa modo JSON con el esquema en el prompt y acepta JSON con texto alrededor', async () => {
    const t = await chainFor({ GROQ_API_KEY: 'q', GROQ_MODEL: 'llama-3.3-70b-versatile', GROQ_FALLBACK_MODELS: 'x' }, {
      groq: () => groqOk('Acá va:\n```json\n{"ok": true, "n": "3"}\n```'),
    });
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true, n: 3 });
    const body = t.groqCalls()[0]!.body;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('JSON Schema');
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('si la API rechaza json_schema para un modelo, pasa a modo JSON y reintenta', async () => {
    const replies = [json({ error: { message: 'response_format json_schema is not supported by this model' } }, 400), groqOk({ ok: true })];
    const t = await chainFor({ GROQ_API_KEY: 'q' }, { groq: () => replies.shift()! });
    await expect(t.ai.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true });
    expect(t.groqCalls()[1]!.body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('esquemas y recorte', () => {
  it('toJsonSchema estricto: todas las propiedades requeridas, opcionales con null y sin propiedades extra', () => {
    expect(toJsonSchema(schema, true)).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' }, note: { type: ['string', 'null'] }, n: { type: ['integer', 'null'] } },
      required: ['ok', 'note', 'n'],
      additionalProperties: false,
    });
    expect(toJsonSchema(schema, false)).toMatchObject({ required: ['ok'], properties: { note: { type: 'string' } } });
  });

  it('conformToSchema quita null de opcionales, convierte números en texto y rechaza tipos incorrectos', () => {
    const s: GeminiSchema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { number: { type: 'STRING' }, pos: { type: 'INTEGER', nullable: true } }, required: ['number'] } };
    expect(conformToSchema([{ number: 7, pos: null }], s)).toEqual({ value: [{ number: '7', pos: null }] });
    expect(conformToSchema([{ number: null }], s).error).toContain('falta el dato');
    expect(conformToSchema([{ number: '1', pos: 1.5 }], s).error).toContain('entero');
  });

  it('condenseText conserva el principio si no hay términos y respeta el tope', () => {
    const text = Array.from({ length: 100 }, (_, i) => `Bloque ${i}`).join('\n\n');
    const out = condenseText(text, 100);
    expect(out.startsWith('Bloque 0')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('parseDuration entiende los formatos de Groq', () => {
    expect(parseDuration('1m26.4s')).toBe(86_400);
    expect(parseDuration('7.66s')).toBe(7660);
    expect(parseDuration('450ms')).toBe(450);
    expect(parseDuration('2h3m')).toBe(7_380_000);
  });
});

describe('trazabilidad y controles con cualquier proveedor', () => {
  it('el modelo que respondió queda en la caché y en la traza (también al leer de la caché), y los controles siguen aplicando', async () => {
    const client = fakeGemini({
      campeonato: (req) => {
        req.onAnswer?.({ provider: 'groq', model: 'openai/gpt-oss-120b' });
        return {
          tables: [
            { title: 'Pilotos', rows: [{ pos: 1, name: 'Juan Pérez', points: 50 }, { pos: 2, name: 'Ana Gómez', points: 40 }] },
            // Inventada: el piloto no figura en el documento -> se descarta igual que con Gemini.
            { title: 'Equipos', rows: [{ pos: 1, name: 'Equipo Fantasma', points: 90 }] },
          ],
        };
      },
    });
    const cache = memoryCache();
    const series = genericSeries('zonal', 'Campeonato Zonal', ['https://zonal.example.org/']);
    const doc = { url: 'https://zonal.example.org/campeonato', kind: 'html' as const, raw: '', title: 'Campeonato', hash: 'h1',
      text: 'Campeonato Zonal 2026 - Pilotos: 1 Juan Pérez 50 pts, 2 Ana Gómez 40 pts' };
    const trace = newTrace();
    const tables = await aiStandings({ gemini: client, cache }, series, 2026, doc, trace);
    expect(tables.map((t) => t.title)).toEqual(['Pilotos']);
    expect(traceModel(trace)).toBe('groq/openai/gpt-oss-120b');
    const again = newTrace();
    await aiStandings({ gemini: client, cache }, series, 2026, doc, again);
    expect(client.requests).toHaveLength(1);
    expect(traceModel(again)).toBe('groq/openai/gpt-oss-120b');
    // El campo es opcional y compatible con los datos existentes.
    const base = { url: doc.url, title: 'x', kind: 'html', method: 'ia', fetchedAt: '2026-11-12T00:00Z' };
    expect(sourceSchema.parse({ ...base, model: 'groq/openai/gpt-oss-120b' }).model).toBe('groq/openai/gpt-oss-120b');
    expect(sourceSchema.parse(base).model).toBeUndefined();
  });
});
