# Migración a app Android + web propia (con base de datos opcional)

> Estado: **solo planificación**. Nada de esto está implementado. Esta carpeta deja todo listo para que, cuando
> decidas arrancar, se pueda ejecutar fase por fase sin volver a investigar desde cero.
> Fecha de consulta de precios, límites y políticas: **2026-11-14** (cada documento cita la fuente).

## Resumen ejecutivo (en 1 minuto)

Hoy la app es una PWA en Vue que lee archivos JSON estáticos generados cada pocas horas por un pipeline en
GitHub Actions, más un Worker de Cloudflare para avisos y tiempos en vivo. **El valor del sistema está en el
pipeline y en los tipos compartidos (`shared/`), no en la interfaz.** Eso define la estrategia:

1. **TypeScript de punta a punta.** `shared/` y `pipeline/` se reusan tal cual; la app nueva solo cambia la capa
   de interfaz.
2. **Expo (React Native + Expo Router)** para Android **y** la web desde un mismo código. La PWA de Vue sigue
   publicada hasta que la versión nueva la iguale; no hay "apagón".
3. **Sin servidor clásico al principio.** El pipeline sigue generando JSON; se publican en un CDN con dominio
   propio. La "API" de la fase 1 es ese conjunto de archivos, con un contrato versionado (ver [api.md](api.md)).
4. **Cloudflare Worker (+ Hono cuando crezca)** para avisos push y proxy de tiempos en vivo. Se le suma
   **Expo Push** (Android) sin perder Web Push (la web).
5. **Base de datos con las cuentas de usuario (fase 3, decidida).** Recomendada: **Supabase (Postgres + Auth + RLS)**.
   Antes de eso, una base no aporta nada que los JSON no den, y suma costo y mantenimiento. Para los dispositivos de
   avisos sin cuentas alcanza con **Cloudflare D1** (o seguir con KV mientras sean pocos).
6. **Atajo barato y válido:** empaquetar la PWA actual como **TWA** para Play Store (una semana de trabajo) mientras
   se construye la app nativa, o en lugar de ella si lo nativo no hace falta.

### Correcciones a la recomendación inicial (tras estudiar el código)

La recomendación del 2026-11-12 se mantiene en lo grueso. Al leer el código aparecieron matices que la cambian
en detalles importantes:

| Tema | Recomendación inicial | Ajuste | Por qué |
|---|---|---|---|
| Publicación de datos | "Pasar de commits a un bucket" | **No es lo primero.** Primero dominio propio delante de lo que ya existe; el bucket (R2) recién si la app es pública o comercial. | El pipeline usa `data/` del repo **como estado** (lee el `schedule.json` anterior para detectar cambios de horario, conservar series con error, `_cache/results-attempts.json`, etc.). Sacar los datos del repo obliga a reescribir esa parte. GitHub Pages no admite uso comercial. |
| Contrato de datos | Implícito | **Los JSON pasan a ser una API pública con versiones.** Cambios solo aditivos; ruptura = carpeta `v2/`. | Hoy app y datos se publican juntos en el mismo build. Con una app instalada desde Play Store conviven versiones viejas durante meses. |
| Avisos push | Worker + FCM/Expo | Igual, pero **la web sigue con Web Push (VAPID)**: `expo-notifications` no soporta web. Envío en lotes de 100 (Expo Push). | Límites del plan gratis de Workers: 50 subpedidos y 10 ms de CPU por invocación. Hoy se manda un `fetch` por aviso: con más de ~49 avisos en una misma ventana de 5 minutos fallaría. |
| Suscripciones | KV | **D1 (o la tabla `devices` de Supabase)** cuando haya más de un puñado de dispositivos. | Todas las suscripciones viven en **una sola clave** de KV: dos altas simultáneas se pisan (la última escritura gana) y el plan gratis permite 1.000 escrituras por día. |
| En vivo | Proxy en el Worker | En **Android nativo** NASCAR, MotoGP y Speedhive se pueden pedir **directo desde el teléfono** (no hay CORS). El proxy queda para la web. | CORS es una restricción del navegador. Además MotoGP bloquea a Cloudflare, así que desde el teléfono podría andar lo que hoy es solo enlace (a verificar, y ojo con los términos de uso: ver [publicacion-y-legal.md](publicacion-y-legal.md)). |
| Google Calendar | Portar el flujo | En Android, **escribir directo en el calendario del teléfono** (`expo-calendar`), sin OAuth. El flujo con Google Identity Services queda solo para la web. | GIS en modo token es solo para navegador; el calendario de Android ya sincroniza con la cuenta de Google. |
| Base de datos | Supabase | Supabase **para cuentas y datos de usuario**. El catálogo (horarios, resultados) se sigue sirviendo desde el CDN aunque también se cargue en la base. | El plan gratis de Supabase incluye 5 GB de egreso por mes; `schedule.json` pesa 1,2 MB (≈150 KB comprimido). Servir el catálogo desde la base agotaría el cupo; el CDN no cobra egreso. |

## Mapa de documentos

| Documento | Para qué sirve |
|---|---|
| [arquitectura.md](arquitectura.md) | Hoy vs. objetivo (diagramas), qué se reusa tal cual, qué cambia, dónde vive cada cosa. |
| [base-de-datos.md](base-de-datos.md) | Modelo de datos completo, esquema Postgres de referencia, carga desde el pipeline, RLS, proveedores comparados y cuándo vale la pena. |
| [api.md](api.md) | Contrato de los datos estáticos (versionado, manifiesto, caché/ETag) y de la API del Worker; cómo lee la app y cómo funciona sin conexión. |
| [app-react-native.md](app-react-native.md) | Stack concreto de la app Expo, inventario de `app/src` archivo por archivo, equivalencias de pantallas, orden de porteo y tareas previas en el código actual. |
| [publicacion-y-legal.md](publicacion-y-legal.md) | Play Store (cuenta, pruebas cerradas, privacidad, firma, EAS), dominio y web propia, riesgos legales de una app pública y qué cambia si es de uso propio. |
| [cuentas-y-monetizacion.md](cuentas-y-monetizacion.md) | Decisiones tomadas; métodos de inicio de sesión y su configuración; modelo gratis + Pro; suscripciones (Play Billing + RevenueCat), publicidad (AdMob) y requisitos para monetizar. |
| [plan-por-fases.md](plan-por-fases.md) | Fases 0 a 5 con checklist, criterios de "terminado", esfuerzo relativo, costos mensuales y riesgos. |
| [dominio.md](dominio.md) | Fase 0.1 hecha: nombre (Grid Agenda), dominio (gridagenda.com), las tres direcciones, variables, orden del cambio de dirección y cómo volver atrás. |

Orden de lectura sugerido: este README → `plan-por-fases.md` → el documento de la fase en la que estés.

## Decisiones tomadas (2026-11-14)

Detalle completo en [cuentas-y-monetizacion.md](cuentas-y-monetizacion.md).

| Pregunta | Respuesta | Qué implica |
|---|---|---|
| ¿Uso propio o app pública? | **Uso propio por ahora** | Fases 0 a 3 sin trámites de producción en Play ni revisión legal. Se diseña todo "listo para ser público": dominio propio y contrato versionado desde el día uno. Distribución: Play con prueba interna, o APK con cuenta de "distribución limitada" (hasta 20 dispositivos; desde 2027 Google exige verificar al desarrollador también fuera de Play). |
| ¿Cuentas de usuario? | **Sí: email y Google, más otro método** | La fase 3 (Supabase Auth + Postgres + RLS) deja de ser opcional. Métodos: **Google** (selector nativo de Android), **email con código de 6 dígitos** (sin contraseña) y, como tercero, **llaves de acceso (passkeys)** cuando Supabase las saque de beta. Por debajo, usuario **anónimo** desde el primer uso que se convierte en cuenta sin perder nada. Las cuentas son opcionales: la agenda nunca pide registrarse. |
| ¿Monetización? | **En el futuro: publicidad y suscripción** | Nueva **fase 5**, después de publicar: gratis con banner (AdMob) + **Pro** sin publicidad y con funciones propias (avisos avanzados, `.ics` personal, temas), cobrado con Play Billing vía RevenueCat. Lo que se cobra nunca son los datos de terceros. Antes de monetizar: revisión legal, Open-Meteo comercial, datos fuera de GitHub Pages, Supabase Pro y contador. Desde la fase 1 se dejan los "enchufes" vacíos (un solo `useEntitlements()`, espacios de anuncio, banderas de funciones). |

### Otras preguntas (menos urgentes)

| Pregunta | Recomendado | Si la respuesta es otra |
|---|---|---|
| ¿iPhone también? | No por ahora (Expo lo deja listo para después). | Cuenta de Apple Developer (USD 99/año) y probar avisos en iOS. |
| ¿Dominio `.com` o `.com.ar`? | **Decidido (2026-11-25): `gridagenda.com`** en Cloudflare Registrar. Ver [dominio.md](dominio.md). | `.app` y `.com.ar` estaban libres ese día; son opcionales. |
| ¿Nombre de la app? | **Decidido (2026-11-25): "Grid Agenda"**, paquete `com.gridagenda.app`. Sin marcas ajenas en el nombre ni en el ícono. | Ver [publicacion-y-legal.md](publicacion-y-legal.md#marcas). |
| ¿Mantener la PWA de Vue? | Sí, hasta que la web de Expo la iguale. Después, redirigir. | Si preferís seguir con Vue para la web, Expo queda solo para Android y se comparten `shared/` y la lógica pura; se mantienen dos interfaces. |
| ¿Repositorio público o privado? | Público (Actions gratis sin límite de minutos y Pages gratis). | Privado: unos USD 12/mes de cómputo incluido (~2.000 minutos Linux), que el pipeline actual podría agotar. |
| ¿Quién administra las categorías? | Como hoy: `config/series.user.json` vía la API de GitHub desde Ajustes (solo el dueño). | Con cuentas, se puede pasar a un rol "admin" en la base, pero no hace falta. |

## Decisiones recomendadas (con alternativas)

| Decisión | Recomendado | Alternativas y cuándo convienen |
|---|---|---|
| Lenguaje | TypeScript en todo | Kotlin nativo: solo si quisieras abandonar la web y reescribir todo. Flutter (Dart): pierde el reuso de `shared/`. |
| App | Expo SDK 58 (React Native 0.88) + Expo Router | TWA/Bubblewrap de la PWA (lo más barato), Capacitor (PWA en WebView con plugins nativos), React Native "pelado" (más configuración sin ventajas acá). |
| Estado de la app | TanStack Query (datos remotos) + Zustand (preferencias) | Redux Toolkit (más ceremonia), Jotai, Legend State. |
| Datos de lectura | JSON estáticos en CDN con dominio propio | API con base de datos (más cara y lenta para leer lo mismo). |
| Hosting de datos | Fase 1: GitHub Pages detrás del dominio. Si es pública: Cloudflare R2 (sin costo de egreso) o Workers Static Assets. | Supabase Storage o Firebase Hosting (cupos de transferencia chicos en los planes gratis). |
| Avisos | Worker (cron) + Expo Push (Android) + Web Push (web) | FCM directo (más trabajo de credenciales, sin recibos de Expo), OneSignal (SDK de terceros a declarar). |
| Base de datos (cuando haga falta) | Supabase (Postgres + Auth + RLS) | Neon + Better Auth (Postgres sin pausas, auth por tu cuenta), Cloudflare D1 (SQLite, ideal para dispositivos sin cuentas), Firebase (NoSQL, buen push, peor para consultas relacionales). |
| Builds | EAS Build (15 de Android en el plan gratis) | Build local con Android Studio (`npx expo run:android --variant release`). |

## Qué NO hacer (para no gastar de más)

- No montar un servidor Node/Express ni una base de datos "por las dudas": el sistema actual funciona sin ellos.
- No reescribir el pipeline: ya es TypeScript y produce el contrato que la app nativa necesita.
- No portar pantalla por pantalla mezclando lógica: primero mover lógica a `lib/` puro (fase 0) y después portar
  la interfaz.
- No romper el formato de los JSON mientras haya versiones de la app instaladas que lo lean.
- No subir a Play Store como app pública antes de resolver logos, fotos de sitios oficiales y el proxy en vivo.
