import { describe, expect, it } from 'vitest';
import {
  createGemini,
  DEFAULT_EXTRACT_MODEL,
  GeminiBudgetError,
  GeminiUnavailableError,
  parseLooseJson,
  type GeminiSchema,
} from '../src/extract/gemini.ts';

const schema: GeminiSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('cliente de Gemini', () => {
  it('sin GEMINI_API_KEY no está disponible y falla con un mensaje claro', async () => {
    const g = createGemini({ env: {}, fetchImpl: async () => okResponse({}) });
    expect(g.available).toBe(false);
    await expect(g.generateJson({ prompt: 'x', schema })).rejects.toBeInstanceOf(GeminiUnavailableError);
    await expect(g.generateJson({ prompt: 'x', schema })).rejects.toThrow('Falta GEMINI_API_KEY');
  });

  it('pide JSON estructurado con temperatura 0, PDF inline y la clave en un header (no en la URL)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const g = createGemini({
      env: { GEMINI_API_KEY: 'secreta-123', GEMINI_DELAY_MS: '0' },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return okResponse({ ok: true });
      },
      sleep: async () => {},
    });
    const out = await g.generateJson<{ ok: boolean }>({ prompt: 'Transcribí', schema, pdf: new Uint8Array([37, 80, 68, 70]) });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_EXTRACT_MODEL}:generateContent`);
    expect(calls[0]!.url).not.toContain('secreta');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secreta-123');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig).toEqual({ temperature: 0, responseMimeType: 'application/json', responseSchema: schema });
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'application/pdf', data: 'JVBERg==' });
  });

  it('reintenta ante 429/503 con espera y respeta el tope de llamadas por corrida', async () => {
    const statuses = [429, 503, 200, 200];
    const waits: number[] = [];
    const g = createGemini({
      env: { GEMINI_API_KEY: 'k', GEMINI_MAX_CALLS: '2', GEMINI_DELAY_MS: '0' },
      fetchImpl: async () => {
        const s = statuses.shift()!;
        return s === 200
          ? okResponse({ ok: true })
          : new Response(JSON.stringify({ error: { message: 'Resource exhausted', details: [{ retryDelay: '7s' }] } }), { status: s });
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await expect(g.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true });
    expect(waits.filter((w) => w >= 5000)).toEqual([7000, 15000]);
    await g.generateJson({ prompt: 'b', schema });
    expect(g.callsMade()).toBe(2);
    await expect(g.generateJson({ prompt: 'c', schema })).rejects.toBeInstanceOf(GeminiBudgetError);
  });

  it('no reintenta errores 4xx y no expone la clave en el mensaje', async () => {
    const g = createGemini({
      env: { GEMINI_API_KEY: 'secreta-123', GEMINI_DELAY_MS: '0' },
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }),
      sleep: async () => {},
    });
    const err = await g.generateJson({ prompt: 'a', schema }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 400');
    expect((err as Error).message).not.toContain('secreta');
  });

  it('Vertex AI usa el endpoint del proyecto con token Bearer', async () => {
    let seen = '';
    let auth = '';
    const g = createGemini({
      env: { GEMINI_PROVIDER: 'vertex', GOOGLE_CLOUD_PROJECT: 'mi-proyecto', GOOGLE_CLOUD_LOCATION: 'us-central1', GOOGLE_ACCESS_TOKEN: 'tok', GEMINI_MODEL: 'gemini-x', GEMINI_DELAY_MS: '0' },
      fetchImpl: async (url, init) => {
        seen = String(url);
        auth = (init!.headers as Record<string, string>).Authorization!;
        return okResponse({ ok: true });
      },
    });
    await g.generateJson({ prompt: 'a', schema });
    expect(seen).toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/mi-proyecto/locations/us-central1/publishers/google/models/gemini-x:generateContent');
    expect(auth).toBe('Bearer tok');
    expect(createGemini({ env: { GEMINI_PROVIDER: 'vertex' } }).available).toBe(false);
  });

  it('búsqueda con Google: usa el modelo de búsqueda y devuelve texto y fuentes', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    const g = createGemini({
      env: { GEMINI_API_KEY: 'k', GEMINI_SEARCH_MODEL: 'gemini-2.5-flash', GEMINI_DELAY_MS: '0' },
      fetchImpl: async (u, init) => {
        url = String(u);
        body = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: '```json\n[{"championship":"Top Race"}]\n```' }] },
                groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org/x', title: 'example.org' } }] },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const res = await g.searchGrounded('buscar');
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(res.sources).toEqual([{ url: 'https://example.org/x', title: 'example.org' }]);
    expect(parseLooseJson(res.text)).toEqual([{ championship: 'Top Race' }]);
  });
});

describe('cupo diario gratuito por modelo', () => {
  const schema: GeminiSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };
  const dailyQuota = () =>
    new Response(
      JSON.stringify({
        error: {
          message: 'You exceeded your current quota',
          details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }],
        },
      }),
      { status: 429 },
    );

  it('si un modelo agotó su cupo diario pasa al siguiente sin esperar, y no lo vuelve a probar en la corrida', async () => {
    const asked: string[] = [];
    const waits: number[] = [];
    const g = createGemini({
      env: { GEMINI_API_KEY: 'k', GEMINI_DELAY_MS: '0', GEMINI_MODEL: 'm1', GEMINI_FALLBACK_MODELS: 'm2,m3' },
      fetchImpl: async (url) => {
        const model = String(url).match(/models\/([^:]+):/)![1]!;
        asked.push(model);
        if (model === 'm1') return dailyQuota();
        if (model === 'm2') return new Response('{}', { status: 404 });
        return okResponse({ ok: true });
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await expect(g.generateJson({ prompt: 'a', schema })).resolves.toEqual({ ok: true });
    await expect(g.generateJson({ prompt: 'b', schema })).resolves.toEqual({ ok: true });
    expect(asked).toEqual(['m1', 'm2', 'm3', 'm3']);
    expect(waits.filter((w) => w >= 5000)).toEqual([]);
    expect(g.callsMade()).toBe(2);
  });

  it('si todos agotaron el cupo, falla con un error de "no disponible" (los datos quedan a confirmar)', async () => {
    const g = createGemini({
      env: { GEMINI_API_KEY: 'k', GEMINI_DELAY_MS: '0', GEMINI_MODEL: 'm1', GEMINI_FALLBACK_MODELS: 'm2' },
      fetchImpl: async () => dailyQuota(),
      sleep: async () => {},
    });
    const err = await g.generateJson({ prompt: 'a', schema }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GeminiUnavailableError);
    expect((err as Error).message).toContain('cupo diario gratuito de Gemini (modelos: m1, m2)');
  });
});
