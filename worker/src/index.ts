/**
 * Cloudflare Worker de Agenda Deporte Motor (plan gratuito).
 *
 * - Avisos push: la app registra la suscripción del dispositivo con sus categorías y la anticipación;
 *   cada 5 minutos el cron lee data/schedule.json publicado en GitHub Pages y avisa las sesiones que
 *   empiezan pronto. Todas las suscripciones viven en una sola clave de KV (se escribe solo al
 *   suscribirse/darse de baja o al limpiar suscripciones vencidas).
 * - Proxy de tiempos en vivo: reenvía GET a una lista cerrada de fuentes oficiales que no permiten
 *   lectura directa desde el navegador (CORS), con caché de pocos segundos.
 */
import { buildPushHTTPRequest } from '@pushforge/builder';
import type { ScheduleFile } from '@dm/shared';
import { PROXY_ALLOWLIST } from './allowlist.ts';
import { dueNotifications, isAllowedUpstream, parseSubscribeBody, windowStart, type Notification, type SubscriberRecord } from './due.ts';

export interface Env {
  SUBS: KVNamespace;
  VAPID_PRIVATE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  DATA_BASE: string;
  APP_URL: string;
  ALLOWED_ORIGINS: string;
  ADMIN_CONTACT: string;
}

const SUBS_KEY = 'subs';
const MAX_SUBSCRIBERS = 500;

type SubsMap = Record<string, SubscriberRecord>;

async function readSubs(env: Env): Promise<SubsMap> {
  return ((await env.SUBS.get<SubsMap>(SUBS_KEY, 'json')) ?? {}) as SubsMap;
}

async function writeSubs(env: Env, subs: SubsMap): Promise<void> {
  await env.SUBS.put(SUBS_KEY, JSON.stringify(subs));
}

async function idFor(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
}

async function sendPush(env: Env, sub: SubscriberRecord, n: Pick<Notification, 'title' | 'body' | 'path' | 'sessionId'>): Promise<number> {
  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK: env.VAPID_PRIVATE_KEY,
    subscription: sub.subscription,
    message: {
      payload: { title: n.title, body: n.body, url: env.APP_URL + n.path, tag: n.sessionId },
      adminContact: env.ADMIN_CONTACT,
      // El aviso deja de tener sentido cuando la sesión ya empezó.
      options: { urgency: 'high', ttl: 30 * 60, topic: n.sessionId.slice(0, 32) },
    },
  });
  const res = await fetch(endpoint, { method: 'POST', headers, body });
  return res.status;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/api/vapid' && request.method === 'GET') {
    return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, cors);
  }

  if (url.pathname === '/api/subscribe' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const endpoint = (body as { subscription?: { endpoint?: unknown } } | null)?.subscription?.endpoint;
    if (typeof endpoint !== 'string') return json({ error: 'Suscripción inválida' }, 400, cors);
    const record = parseSubscribeBody(body, await idFor(endpoint), new Date().toISOString());
    if (typeof record === 'string') return json({ error: record }, 400, cors);
    const subs = await readSubs(env);
    if (!subs[record.id] && Object.keys(subs).length >= MAX_SUBSCRIBERS) return json({ error: 'Cupo de dispositivos completo' }, 503, cors);
    subs[record.id] = record;
    await writeSubs(env, subs);
    return json({ ok: true, id: record.id, seriesIds: record.seriesIds.length, leadMinutes: record.leadMinutes }, 200, cors);
  }

  if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== 'string') return json({ error: 'Falta endpoint' }, 400, cors);
    const id = await idFor(body.endpoint);
    const subs = await readSubs(env);
    if (subs[id]) {
      delete subs[id];
      await writeSubs(env, subs);
    }
    return json({ ok: true }, 200, cors);
  }

  if (url.pathname === '/api/test' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== 'string') return json({ error: 'Falta endpoint' }, 400, cors);
    const sub = (await readSubs(env))[await idFor(body.endpoint)];
    if (!sub) return json({ error: 'Este dispositivo no está suscripto' }, 404, cors);
    const status = await sendPush(env, sub, {
      title: 'Deporte Motor: avisos activados',
      body: `Te vamos a avisar ${sub.leadMinutes} minutos antes de cada sesión de lo que seguís.`,
      path: '#/',
      sessionId: 'prueba',
    });
    return json({ ok: status >= 200 && status < 300, status }, 200, cors);
  }

  if (url.pathname === '/api/proxy' && request.method === 'GET') {
    const target = url.searchParams.get('url') ?? '';
    if (!isAllowedUpstream(target, PROXY_ALLOWLIST)) return json({ error: 'Fuente no permitida' }, 403, cors);
    // Caché corta en el borde de Cloudflare: muchos usuarios mirando la misma carrera = 1 pedido a la fuente.
    const upstream = await fetch(target, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AgendaDeporteMotor/1.0; tiempos en vivo)' },
      cf: { cacheTtl: 5, cacheEverything: true },
    });
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json');
    headers.set('Cache-Control', 'public, max-age=5');
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  return json({ error: 'No encontrado' }, 404, cors);
}

async function runNotifications(scheduledTime: number, env: Env): Promise<void> {
  const subs = await readSubs(env);
  const list = Object.values(subs);
  if (list.length === 0) return;
  const res = await fetch(`${env.DATA_BASE}/schedule.json`, { cf: { cacheTtl: 240, cacheEverything: true } });
  if (!res.ok) {
    console.log(`No se pudo leer schedule.json: HTTP ${res.status}`);
    return;
  }
  const schedule = (await res.json()) as ScheduleFile;
  const due = dueNotifications(schedule, list, windowStart(scheduledTime));
  if (due.length === 0) return;

  const expired = new Set<string>();
  await Promise.all(
    due.map(async (n) => {
      const sub = subs[n.subscriberId];
      if (!sub || expired.has(sub.id)) return;
      try {
        const status = await sendPush(env, sub, n);
        // 404/410: el navegador dio de baja la suscripción.
        if (status === 404 || status === 410) expired.add(sub.id);
      } catch (err) {
        console.log(`Aviso fallido (${sub.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  console.log(`Avisos enviados: ${due.length}, suscripciones vencidas: ${expired.size}`);
  if (expired.size > 0) {
    const fresh = await readSubs(env);
    for (const id of expired) delete fresh[id];
    await writeSubs(env, fresh);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return new Response('Agenda Deporte Motor — API de avisos y tiempos en vivo.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runNotifications(controller.scheduledTime, env));
  },
} satisfies ExportedHandler<Env>;
