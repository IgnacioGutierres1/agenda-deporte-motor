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
5. **Base de datos recién cuando haya cuentas de usuario.** Recomendada: **Supabase (Postgres + Auth + RLS)**. Antes
   de eso, una base no aporta nada que los JSON no den, y suma costo y mantenimiento. Para los dispositivos de
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
| [plan-por-fases.md](plan-por-fases.md) | Fases 0 a 4 con checklist, criterios de "terminado", esfuerzo relativo, costos mensuales y riesgos. |

Orden de lectura sugerido: este README → `plan-por-fases.md` → el documento de la fase en la que estés.

## Preguntas que tenés que contestar antes de arrancar

Las respuestas cambian la recomendación. Para cada pregunta va la opción que recomiendo si no sabés qué elegir.

### 1. ¿Uso propio (vos y algunos conocidos) o app pública en Play Store?

| Respuesta | Qué cambia |
|---|---|
| **Uso propio** | Se puede quedar todo en el plan gratis y en GitHub Pages. No hacen falta política de privacidad formal, formulario de seguridad de datos ni cuidado extremo con logos y fotos. Distribución: APK directo o Play Store con prueba interna/cerrada. Ojo: desde 2027 Google exige verificar al desarrollador también para instalar APK fuera de Play en teléfonos certificados; para pocos dispositivos hay una cuenta de "distribución limitada" (hasta 20 dispositivos, sin documento ni arancel). **Hasta podría alcanzar con la TWA** de la PWA actual. |
| **App pública** | Dominio propio obligatorio, datos fuera de GitHub Pages (sus términos no permiten un "negocio en línea"), política de privacidad, formulario de seguridad de datos, prueba cerrada de 12 testers durante 14 días (cuentas personales nuevas), revisión legal de logos, fotos y del proxy en vivo (ver [publicacion-y-legal.md](publicacion-y-legal.md)). |

**Recomendado:** empezar como uso propio "preparado para ser público" (dominio propio y contrato versionado
desde el día uno) y decidir la publicación cuando la app nativa esté andando.

### 2. ¿Cuentas de usuario?

| Respuesta | Qué cambia |
|---|---|
| **No** (todo queda en el dispositivo, como hoy) | No hace falta base de datos. Los avisos se guardan por dispositivo en D1/KV. No aplica la obligación de borrado de cuenta de Play Store. |
| **Sí, opcionales** ("iniciá sesión para sincronizar lo que seguís") | Supabase Auth + Postgres + RLS (fase 3). Hay que ofrecer borrado de cuenta dentro de la app **y** desde una página web. Opción intermedia: usuarios anónimos de Supabase (cada instalación tiene un id sin pedir email) y "convertir" a cuenta con Google cuando el usuario quiera. |
| **Sí, obligatorias** | No lo recomiendo: es una barrera de entrada para una agenda que hoy funciona sin registrarse. |

**Recomendado:** sin cuentas en las fases 1 y 2; cuentas **opcionales** en la fase 3, solo si de verdad querés
sincronizar entre dispositivos o mandar avisos por piloto o equipo calculados en el servidor.

### 3. ¿Monetización (publicidad, suscripción, donaciones)?

| Respuesta | Qué cambia |
|---|---|
| **Ninguna** | Open-Meteo gratis sigue valiendo (uso no comercial). Riesgo legal bajo. |
| **Donaciones voluntarias** | Open-Meteo las permite expresamente ("tip jar"). Sin cambios grandes. |
| **Publicidad o suscripción** | Open-Meteo pasa a ser comercial (plan pago) o hay que cambiar de proveedor del clima. GitHub Pages queda descartado. Los términos de las fuentes oficiales (F1, MotoGP, etc.) pesan mucho más: datos, fotos y tiempos en vivo de terceros en un producto comercial. Conviene consultar con un abogado. Con publicidad, el formulario de seguridad de datos declara el SDK de anuncios y su identificador. |

**Recomendado:** sin monetización o, a lo sumo, donaciones. Una app de agenda de nicho difícilmente cubra con
publicidad el riesgo legal y los planes pagos que dispara.

### 4. Otras preguntas (menos urgentes)

| Pregunta | Recomendado | Si la respuesta es otra |
|---|---|---|
| ¿iPhone también? | No por ahora (Expo lo deja listo para después). | Cuenta de Apple Developer (USD 99/año) y probar avisos en iOS. |
| ¿Dominio `.com` o `.com.ar`? | `.com` en Cloudflare Registrar (a precio de costo, renovación sin sorpresas) o `.com.ar` si querés marcar lo argentino (NIC Argentina, arancel en pesos). | Cualquiera sirve; lo importante es tenerlo antes de publicar la app (App Links y TWA lo necesitan). |
| ¿Nombre de la app? | Uno propio sin marcas ajenas ("Agenda Deporte Motor" está bien; evitar "F1", "MotoGP", etc. en el nombre y el ícono). | Ver [publicacion-y-legal.md](publicacion-y-legal.md#marcas). |
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
