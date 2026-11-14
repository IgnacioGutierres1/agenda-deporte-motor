# API: contrato de datos y del Worker

Volver al [README](README.md).

Hay dos "APIs" y conviene no mezclarlas:

1. **Datos estáticos** (`data.<dominio>/v1/…`): todo lo que genera el pipeline. Solo lectura, cacheable, igual para
   todos los usuarios. Es el 95 % del tráfico.
2. **API dinámica** (`api.<dominio>/v1/…`, Worker): lo que depende del usuario o del momento: avisos, tiempos en vivo
   y (fase 3) sincronización de cuentas.

Los datos del usuario con cuenta (fase 3) se leen y escriben **directo contra Supabase** con `supabase-js` y RLS; el
Worker solo interviene en lo que necesita la clave de servicio (alta de dispositivos, borrado de cuenta, envío de
avisos).

## 1. Datos estáticos

### 1.1 Rutas (las mismas de hoy, bajo un prefijo de versión)

| Ruta | Tipo (`shared/src`) | Tamaño hoy | Cuándo la pide la app |
|---|---|---|---|
| `v1/manifest.json` | **nuevo** `DataManifest` | ~10 KB | Al abrir y al volver a primer plano |
| `v1/upcoming.json` | **nuevo** `ScheduleFile` recortado (ayer → +14 días) | ~100 KB | Al abrir (Agenda y En vivo) y en el cron del Worker |
| `v1/schedule.json` | `ScheduleFile` | 1,2 MB | Calendario completo (categorías, búsqueda, exportar) |
| `v1/status.json` | `StatusFile` | 12 KB | Auditoría, avisos de fuente |
| `v1/standings/{seriesId}.json` | `StandingsFile` | 5–40 KB | Pestaña Tabla |
| `v1/results/{seriesId}/{eventId}.json` | `EventResultsFile` | 10–80 KB | Resultados de un evento, podio, contexto |
| `v1/rosters/{seriesId}.json` | `RosterFile` | 10–60 KB | Plantel |
| `v1/drivers-index.json` | `DriversIndexFile` | 572 KB | Buscar, seguir, recomendaciones |
| `v1/drivers/{shard}.json` | `DriverShardFile` (256 grupos, `driverShardPath`) | ~6 KB | Ficha de piloto |
| `v1/teams.json` | `TeamsFile` | 308 KB | Equipos |
| `v1/circuits.json` | `CircuitsFile` | 256 KB | Circuitos, clima (coordenadas) |
| `v1/tracks/{circuitId}.json` | `CircuitTrackFile` | ~4 KB | Trazado |
| `v1/stages/{seriesId}/{eventId}.json` | `EventStagesFile` | ~8 KB | Tramos/etapas |
| `v1/news.json` | `NewsFile` | 204 KB | Noticias |
| `v1/bios/drivers/{shard}.json`, `v1/bios/teams.json`, `v1/bios/series.json` | `profiles.ts` | — | Historial (tanda 5) |
| `v1/feeds/{id}.ics`, `v1/feeds/deporte-motor.ics` | iCalendar | — | Suscripción webcal |

`drivers.json` (948 KB, todas las fichas) se sigue publicando por compatibilidad, pero la app nueva no lo usa.

**Sobre el prefijo `v1/`:** hoy la ruta es `data/…`. Para no romper la PWA actual, el pipeline puede escribir en
`data/` como siempre y el paso de publicación copiar a `v1/` (o el CDN reescribir `v1/*` → `data/*`). Lo
importante es que **la app nueva solo conozca URLs con versión**.

<a id="manifiesto"></a>

### 1.2 Manifiesto

Un archivo chico que dice qué hay y qué cambió. Permite que la app pida solo lo que cambió (en lugar de revalidar
uno por uno) y que el Worker o la carga a la base sepan qué procesar.

```ts
// Propuesta para shared/src/types.ts (aditivo, fase 0 o 1). No implementado.
export interface DataManifest {
  version: 1;
  /** = schedule.generatedAt de esta corrida. */
  generatedAt: string;
  /** Versión mínima de la app que entiende estos datos. Si la instalada es menor: "Actualizá la app". */
  minAppVersion?: string;
  /** Aviso opcional para mostrar arriba de todo (caída de una fuente, mantenimiento). */
  notice?: { text: string; url?: string; until?: string };
  /** Ruta relativa → huella del contenido (primeros 16 hex de SHA-256) y bytes. */
  files: Record<string, { hash: string; bytes: number }>;
}
```

- Lo genera el último paso del pipeline (recorre `data/`, excluye `_cache/`).
- Con los ~700 archivos de hoy (sin `_cache/`) y ~60 bytes por entrada pesa ~40 KB sin comprimir y ~10 KB
  comprimido. Si crece, partirlo
  por carpeta (`manifest/results.json`).
- La app guarda el manifiesto anterior; al llegar uno nuevo, invalida en su caché solo las rutas cuyo `hash`
  cambió.

### 1.3 Caché HTTP y ETag

| Origen | Comportamiento |
|---|---|
| GitHub Pages (hoy) | Envía `ETag` y `Last-Modified` y `Cache-Control: max-age=600`. `fetch` con `cache: 'no-cache'` revalida con `If-None-Match` y recibe `304` si no cambió (lo que hace hoy `fetchData`). |
| R2 con dominio propio | Envía `ETag`. El `Cache-Control` se fija al subir cada objeto: `public, max-age=60, stale-while-revalidate=600` para los JSON que cambian; `max-age=86400` para `tracks/`; `max-age=31536000, immutable` si algún día se publican archivos con hash en el nombre. |
| Cloudflare delante | Respeta esos encabezados y comprime con gzip/brotli (los JSON bajan ~8–10 veces). |

En React Native, `fetch` **no** tiene caché HTTP persistente confiable entre aperturas de la app (depende de la
plataforma). Por eso la app guarda ella misma el cuerpo **y** el `ETag` de cada archivo y manda `If-None-Match` a
mano. Ver "Cómo lee la app".

### 1.4 Versionado y compatibilidad

Reglas para el contrato `v1` (escribirlas en el README del repo cuando se implemente):

1. **Solo cambios aditivos:** campos nuevos **opcionales**, valores nuevos de enums **solo si la app los tolera**
   (ver 3), archivos nuevos.
2. **Nunca** renombrar ni borrar campos, cambiar tipos, cambiar el formato de ids (`stableHash`, `driverShard`,
   `DRIVER_SHARDS = 256`, slugs) ni mover rutas.
3. La app trata los enums como abiertos: un `SessionType` o `SeriesGroup` desconocido se muestra como "otro" en vez
   de romper. Esto hay que programarlo desde el primer día (con `zod`: `.catch('otro')`).
4. Ruptura inevitable → publicar `v2/` **en paralelo** con `v1/` durante al menos 6 meses o hasta que
   `minAppVersion` haga actualizar a todos.
5. Un test en `shared/` que compare los esquemas zod con una copia congelada de `v1` y falle si se quita algo.

### 1.5 Paginación

No hace falta en los estáticos: los archivos ya están partidos por serie, evento y grupo de pilotos. Los dos
grandes tienen alternativa liviana: `schedule.json` → `upcoming.json`; `drivers.json` → `drivers-index.json` +
fichas por grupo. Si `news.json` crece, partir por mes (`news/2026-11.json`).

## 2. API dinámica (Worker en `api.<dominio>`)

### 2.1 Hoy

| Método y ruta | Qué hace |
|---|---|
| `GET /api/vapid` | Clave pública VAPID |
| `POST /api/subscribe` | Alta/actualización de una suscripción Web Push con `seriesIds`, `leadMinutes`, `timeZone` |
| `POST /api/unsubscribe` | Baja por `endpoint` |
| `POST /api/test` | Aviso de prueba |
| `GET /api/proxy?url=` | Proxy GET a la lista cerrada `PROXY_ALLOWLIST` |

### 2.2 Objetivo (`/v1`, manteniendo `/api/*` mientras exista la PWA vieja)

| Método y ruta | Auth | Cuerpo / respuesta | Notas |
|---|---|---|---|
| `GET /v1/health` | — | `{ok, dataVersion}` | Monitoreo |
| `GET /v1/push/vapid` | — | `{publicKey}` | Solo web |
| `PUT /v1/devices/:token` | Fase 2: ninguna (el token es el secreto). Fase 3: JWT de Supabase opcional | `{platform, pushKind, webpushKeys?, seriesIds, leadMinutes, timeZone, appVersion}` → `{id}` | Idempotente (upsert por token). Con JWT, `user_id` = `sub` y `seriesIds` se ignora (salen de `follows`). |
| `DELETE /v1/devices/:token` | Ídem | `204` | |
| `POST /v1/devices/:token/test` | Ídem | `{ok, status}` | |
| `GET /v1/live/proxy?url=` | — | Respuesta de la fuente | Igual que hoy; solo la usa la web |
| `GET /v1/me/calendar.ics?k=<clave>` | Clave secreta por usuario | iCalendar | Fase 3, opcional: `.ics` personal con lo seguido (`buildIcs`) |
| `DELETE /v1/me` | JWT | `204` | Fase 3: borra la cuenta (`auth.admin.deleteUser`) |
| `POST /v1/account-deletion` | — (formulario web) | `{email}` | Fase 3: pedido de borrado desde la web, exigido por Play Store |

Detalles:

- **Validación** con los esquemas `zod` de `shared/` (o `@hono/zod-validator` si se usa Hono). Mismos límites que
  hoy: hasta 80 categorías, ids `^[a-z0-9-]{1,40}$`, `leadMinutes` en `LEAD_OPTIONS`.
- **CORS**: solo `https://<dominio>` y `localhost` (la app nativa no manda `Origin`).
- **Límite de abuso**: Cloudflare Rate Limiting (reglas gratis) por IP en `PUT /v1/devices` y en el proxy.
- **Errores** con forma única: `{ error: { code: 'invalid_token', message: 'texto en español' } }`.
- **Hono**: no es imprescindible (hoy son 5 rutas a mano). Conviene al pasar de ~8 rutas o al sumar JWT, porque trae
  ruteo, middleware de CORS/JWT y validación con zod en pocas líneas. Es TS, corre en Workers y pesa poco.

### 2.3 Avisos: qué cambia en el envío

- El cron (cada 5 minutos) lee `v1/upcoming.json` en lugar de `schedule.json` (CPU) y los dispositivos activos de
  D1/Postgres.
- `dueNotifications()` de `worker/src/due.ts` se reusa; cambia `path`: hoy es `#/evento/:id` (ruta con hash de la
  PWA), en la app nueva es `/evento/:id` (Expo Router). Mandar ambos en el payload (`url` para web, `data.path` para
  nativo).
- **Expo Push**: lotes de hasta 100 mensajes por pedido (`POST https://exp.host/--/api/v2/push/send`), máximo 600
  avisos por segundo por proyecto; guardar los tickets y pedir recibos ~15 minutos después
  (`/push/getReceipts`) para desactivar tokens con `DeviceNotRegistered`.
- **Web Push**: como hoy (`@pushforge/builder`), un pedido por dispositivo. Con el plan gratis de Workers (50
  subpedidos por invocación) conviene repartir: si hay más de ~40 avisos web en una ventana, encolarlos (Cloudflare
  Queues, plan pago) o partir el envío en varias invocaciones.
- Canal de Android `sesiones` (importancia alta) creado por la app antes de pedir el token; el aviso lleva
  `channelId: 'sesiones'`, `ttl` 1.800 s y `collapse`/`tag` = id de sesión, como hoy.

## 3. Cómo lee la app

```ts
// Diseño de referencia (no implementado): capa de datos de la app Expo.
const DATA_BASE = 'https://data.<dominio>/v1/';

interface CachedFile<T> { etag?: string; hash?: string; savedAt: string; body: T }

async function getDataFile<T>(path: string, schema: ZodType<T>, opts: { force?: boolean } = {}): Promise<T> {
  const cached = await fileCache.get<T>(path);              // expo-file-system (nativo) / IndexedDB (web)
  const manifestHash = currentManifest()?.files[path]?.hash;
  if (cached && !opts.force && manifestHash && cached.hash === manifestHash) return cached.body; // sin red
  const res = await fetch(DATA_BASE + path, {
    headers: cached?.etag ? { 'If-None-Match': cached.etag, Accept: 'application/json' } : { Accept: 'application/json' },
  });
  if (res.status === 304 && cached) return cached.body;
  if (res.status === 404) throw new DataNotFoundError(path);
  if (!res.ok) { if (cached) return cached.body; throw new DataLoadError(path, `Error ${res.status}`); }
  const body = schema.parse(await res.json());              // validar en el borde (ver nota)
  await fileCache.set(path, { etag: res.headers.get('ETag') ?? undefined, hash: manifestHash, savedAt: new Date().toISOString(), body });
  return body;
}
```

- **TanStack Query** envuelve cada archivo en una consulta con clave = ruta (`['data', 'results/f1/ev-…json']`),
  `staleTime` según el tipo (agenda 5 min, tablas 30 min, trazados 7 días) y `queryFn` = `getDataFile`.
- **Validación con zod**: hoy la app **no** valida (confía en el pipeline) y solo carga zod en Ajustes. En una app
  nativa que puede leer datos más nuevos que ella, validar con esquemas **tolerantes** (`.passthrough()`, enums con
  `.catch`) evita cierres inesperados. Medir el costo en `schedule.json` (1.089 sesiones): si pesa, validar solo
  `upcoming.json` y los archivos chicos.
- **Precarga al abrir**: `manifest.json` → `upcoming.json` → pantalla. `schedule.json` completo en segundo plano.
- **Al volver a primer plano** (`AppState` en nativo, `visibilitychange` en web): si pasaron más de 10 minutos,
  pedir el manifiesto (igual que hoy hace `App.vue` con `fetchedAt`).
- **"Actualizar"** (menú): `force: true` sobre lo abierto, igual que `refreshEverything()`.

## 4. Sin conexión

| Qué | Hoy (PWA) | App Expo |
|---|---|---|
| Interfaz | Service Worker (Workbox) precachea JS/CSS | Viene en el APK; actualizaciones de JS con EAS Update |
| Datos | Workbox `NetworkFirst` (`dm-data`, 300 entradas, 60 días), `dm-drivers`, `StaleWhileRevalidate` para `dm-tracks` | Caché propia de archivos (cuerpo + ETag + hash), con límite por carpeta: agenda/estado siempre, resultados y fichas los últimos 300 abiertos, trazados 256 |
| Preferencias y seguidos | `localStorage` (`persistStore`) | Zustand `persist` sobre AsyncStorage (nativo) / `localStorage` (web) |
| Clima | `localStorage` (10 circuitos, 1 h / 12 h) | Igual lógica, almacenamiento cambiado |
| Indicador | "Sin conexión y sin una copia guardada" (`DataLoadError`) | Igual mensaje + `NetInfo` para TanStack Query (`onlineManager`) |

**Dónde guardar la caché de datos en nativo:** no en AsyncStorage para archivos grandes (`schedule.json` pesa
1,2 MB y en Android AsyncStorage históricamente tiene un tope total de ~6 MB, configurable; verificarlo en la
versión que se use). Usar **`expo-file-system`** (un archivo por ruta, como un espejo de `data/`) o
**`expo-sqlite`** (tabla `cache(path primary key, etag, hash, saved_at, body)`). En web, IndexedDB (`idb-keyval`).
El persistidor de TanStack Query (`@tanstack/query-async-storage-persister` con `PersistQueryClientProvider`) sirve
para el estado de las consultas chicas; los archivos grandes conviene manejarlos con la caché propia de arriba.
