# Plan por fases

Volver al [README](README.md). Costos consultados el **2026-11-14** (fuentes en
[base-de-datos.md](base-de-datos.md#fuentes-consultadas-el-2026-11-14) y
[publicacion-y-legal.md](publicacion-y-legal.md#fuentes-consultadas-el-2026-11-14)).

## Vista general

| Fase | Objetivo | Esfuerzo relativo | Costo mensual | ¿Bloquea a la siguiente? |
|---|---|---|---|---|
| **0. Preparación** | Dejar el código actual listo para portar, sin cambios visibles | **M** (≈ 1 tanda de trabajo con agentes) | USD 0 | Sí (lo de 0.1–0.3) |
| **0.5 TWA (opcional)** | La PWA actual en Play Store / instalada como app | **S** | USD 0 (+ USD 25 una vez si va a Play) | No |
| **1. App Expo leyendo los JSON** | Android + web nuevas con las funciones de hoy, sin base | **XL** (la más grande: toda la interfaz) | ~USD 1 (dominio) | Sí |
| **2. Avisos push nativos** | Expo Push + Web Push desde el Worker, dispositivos en D1 | **M** | USD 0 (USD 5 si hace falta Workers Paid) | No |
| **3. Base de datos y cuentas** | Supabase: cuentas opcionales, seguidos sincronizados, espejo del catálogo | **L** | USD 0 → USD 25 (Pro) con usuarios reales | No |
| **4. Publicación** | Play Store producción + web propia como sitio principal | **M** (mucho trámite, poco código) | Igual que la fase anterior | — |

Escala: S ≈ unos días · M ≈ 1–2 semanas · L ≈ 3–4 semanas · XL ≈ 6–10 semanas, con tu ritmo actual de
tandas con agentes y revisión. Son relativas entre sí, no promesas.

Las fases 2 y 3 son independientes: si no querés cuentas, la 3 no se hace nunca. La 4 se puede hacer después de
la 1 o de la 2.

---

## Fase 0: preparación en el código actual

Detalle de cada tarea en [app-react-native.md, sección 5](app-react-native.md#5-qué-preparar-en-el-código-actual-antes-de-migrar-fase-0).
Todo en ramas `feat/…` como siempre; ningún cambio visible para el usuario.

### Checklist

**0.1 Decisiones**
- [ ] Contestar las preguntas del [README](README.md#preguntas-que-tenés-que-contestar-antes-de-arrancar).
- [ ] Elegir y comprar el dominio; poner `data.<dominio>` delante de GitHub Pages y `api.<dominio>` delante del
      Worker. La PWA actual pasa a usar esas URLs (variable `VITE_DATA_BASE` nueva y `WORKER_URL`).

**0.2 Spike de compatibilidad (medio día)**
- [ ] Proyecto Expo descartable que importe `@dm/shared` y muestre la agenda de hoy en un teléfono Android real
      ([lista de verificación](app-react-native.md#spike)). Resultado: "anda" o la lista de ajustes necesarios.

**0.3 Lógica pura**
- [ ] Workspace `core/` (`@dm/core`) con lo que hoy es TS puro en `app/src/lib`, `gcal/`, `github/user-config.ts`.
- [ ] Extraer la lógica de los ~15 componentes de la tabla (≈1.000 líneas) con sus tests.
- [ ] Separar plataforma en `weather`, `data`, `storage`, `push`, `live`, `clock`.
- [ ] Desacoplar `lib/refresh.ts` y `lib/searchContext.ts` de Pinia; quitar el `import()` de vista en
      `stores/drivers.ts`.
- [ ] Tokens de diseño en `core/src/theme-tokens.ts`; tablas de `AppIcon` y `WeatherIcon` como datos.

**0.4 Contrato de datos**
- [ ] `season` en `MotorEvent`; `manifest.json` y `upcoming.json` en el pipeline; publicación también bajo `v1/`.
- [ ] Test de contrato congelado `v1`; enums tolerantes en los esquemas que usará la app.
- [ ] `exports` por subruta en `shared/package.json`.

**0.5 Worker**
- [ ] Rutas `/v1/…`; `path` sin hash en el payload; suscripciones en D1 (o una clave por dispositivo).

### Terminado cuando

- `npm test` y `npm run typecheck` en verde; la PWA se ve y se comporta igual (smoke test con Playwright como
  siempre).
- Ningún componente Vue tiene reglas de negocio en `computed`/`methods` (solo llamadas a `@dm/core`).
- El spike confirmó que `@dm/shared` y `@dm/core` corren en Hermes.
- `data.<dominio>/v1/manifest.json` responde.

---

## Fase 0.5 (opcional): la PWA como app de Android (TWA)

Sirve para tener "la app en el teléfono" o en Play Store ya, mientras se hace la fase 1, o en lugar de ella.

- [ ] Web en el dominio propio (no en `github.io/<repo>`), con `assetlinks.json`.
- [ ] Generar el AAB con Bubblewrap o PWABuilder; probar avisos (delegados a Chrome) y deep links.
- [ ] Prueba interna en Play (o APK para vos).

**Terminado cuando** la app instalada abre sin barra del navegador, los avisos llegan y los enlaces
`https://<dominio>/#/evento/…` abren la app.

---

## Fase 1: app Expo leyendo los JSON actuales

Orden de pantallas en [app-react-native.md, sección 4](app-react-native.md#4-orden-sugerido-de-porteo).

### Checklist

- [ ] `mobile/` (Expo SDK 58, Expo Router, TypeScript estricto) dentro del monorepo; CI con typecheck y tests.
- [ ] Tema (claro/oscuro/sistema, acento verde) desde los tokens; barra inferior de 5 pestañas.
- [ ] Capa de datos: `getDataFile` + caché en archivos + manifiesto + TanStack Query + NetInfo.
- [ ] `settings` en Zustand persistido, con migración desde nada (instalación nueva).
- [ ] Pantallas en el orden sugerido, cada una con su flujo de Maestro.
- [ ] Tiempos en vivo: directo en nativo (solo para uso propio; ver lo legal), proxy en web.
- [ ] Exportar: `expo-calendar`, webcal, compartir `.ics`.
- [ ] Deep links: esquema propio (`deportemotor://`) + App Links en `https://<dominio>/…`.
- [ ] EAS: perfiles `development`, `preview` (APK para probar) y `production` (AAB); EAS Update en el canal `preview`.
- [ ] Web: `output: "static"`, `generateStaticParams` para eventos y categorías, publicación en Cloudflare Pages
      desde Actions (`npx expo export -p web`).
- [ ] Importar lo seguido desde la PWA: en Ajustes de la PWA, "Exportar mis preferencias" (código o QR con el JSON
      de `settings`) → "Importar" en la app nueva. Simple y sin servidor.

### Terminado cuando

- En tu teléfono, la app nueva reemplaza a la PWA en el uso diario durante **un fin de semana largo de carreras**
  (agenda, evento, resultados, tabla, piloto, sin conexión en algún momento) sin volver a la PWA.
- La web de Expo en `<dominio>` muestra lo mismo; Lighthouse móvil razonable (≥ 85 de rendimiento; la PWA de Vue
  hoy da 97-99: la de Expo va a pesar más).
- Los flujos de Maestro pasan en CI o al menos localmente antes de cada build.

### Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Subestimar la interfaz (es el 70 % del trabajo) | Alta | Fase 0 bien hecha; portar por pantallas completas; no agregar funciones nuevas en esta fase. |
| Rendimiento con 1.089 sesiones y 2.300 pilotos | Media | FlashList, `upcoming.json`, memoización de selectores. |
| `luxon` + Hermes | Media | Se detecta en el spike. |
| Web de Expo más pesada que la PWA | Alta | Mantener la PWA de Vue publicada hasta que la nueva sea mejor para vos. |

---

## Fase 2: avisos push nativos

### Checklist

- [ ] Proyecto de Firebase solo para FCM (gratis) y credenciales FCM v1 cargadas en EAS (`eas credentials`).
- [ ] App: canal `sesiones`, pedido de permiso (Android 13+) con explicación previa, `getExpoPushTokenAsync`,
      `PUT /v1/devices/:token`, re-sincronizar al cambiar lo seguido o la anticipación (como hoy `syncPush`).
- [ ] Al tocar el aviso: abrir `/evento/:id` (Expo Router lo maneja con `data.path`).
- [ ] Worker: tabla `devices` + `notifications_sent` en D1; cron lee `upcoming.json`; envío Expo en lotes de 100;
      recibos a los 15 minutos; baja de tokens `DeviceNotRegistered`; Web Push igual que hoy para la web.
- [ ] Migrar las suscripciones Web Push actuales de KV a D1 (script de una vez).
- [ ] Monitoreo: `GET /v1/health` y un registro por corrida (`avisos enviados / errores`).

### Terminado cuando

- Un aviso de prueba llega al teléfono con la app cerrada y en modo ahorro de batería.
- En un fin de semana real, llegan los avisos de lo seguido con la anticipación elegida, sin duplicados, en Android
  y en la web.
- Desactivar avisos borra el dispositivo del Worker.

### Costo

USD 0: Expo Push y FCM son gratis; D1 gratis (100 mil escrituras por día). Workers Paid (USD 5/mes) solo si se
superan los 50 subpedidos o los 10 ms de CPU por invocación con muchos avisos web.

---

## Fase 3: base de datos y cuentas

Diseño completo en [base-de-datos.md](base-de-datos.md).

### Checklist

- [ ] Proyecto de Supabase (región cercana: São Paulo), carpeta `supabase/` con migraciones versionadas.
- [ ] Esquema de catálogo + vistas; RLS en todas las tablas; *Security Advisor* sin alertas.
- [ ] `npm run db:load` en el pipeline (upsert por serie, transacción, borrado acotado) por el pooler; paso en
      `update.yml` con `continue-on-error`.
- [ ] Auth: usuarios anónimos al primer uso + vincular Google ("Iniciar sesión para sincronizar").
- [ ] Tablas de usuario (`profiles`, `follows`, `notification_prefs`, `devices`) y sincronización en la app
      (local primero; al iniciar sesión se suben y fusionan).
- [ ] Worker: dispositivos desde Postgres; categorías de cada dispositivo calculadas desde `follows` (incluye pilotos
      y equipos seguidos, como hoy `followedSeriesIds`).
- [ ] Borrado de cuenta en la app y página web de borrado; política de privacidad actualizada.
- [ ] Respaldo semanal con `pg_dump` desde Actions.
- [ ] (Opcional) `.ics` personal por usuario desde el Worker; avisos de "terminó la carrera".

### Terminado cuando

- Seguís un piloto en el teléfono y aparece seguido en la web con la misma cuenta.
- Borrar la cuenta elimina todo lo del usuario (verificado en la base).
- La carga del pipeline corre en cada actualización sin errores durante una semana, y si se apaga la base la app
  sigue funcionando con los JSON.

### Costo

- Supabase gratis mientras sea uso propio o pocos usuarios: USD 0. Ojo con la **pausa tras 1 semana sin actividad**
  (la carga del pipeline cada pocas horas debería evitarla; confirmarlo) y no contar con copias de seguridad del plan
  gratis (hacer `pg_dump` propio).
- Con usuarios reales: **Pro USD 25/mes** (sin pausa, copias diarias, 8 GB).
- Alternativa: Neon (gratis sin pausa larga, escala a cero; Launch ~USD 15/mes una base chica intermitente).

---

## Fase 4: publicación

Checklist completo en [publicacion-y-legal.md, sección 5](publicacion-y-legal.md#5-checklist-de-publicación).

### Pasos en orden

1. Cuenta de Play (USD 25) y verificación de identidad y dispositivo.
2. Resolver lo legal de la versión pública (fotos, logos, en vivo, Open-Meteo, aviso de app no oficial).
3. Política de privacidad, términos y (si hay cuentas) página de borrado en `<dominio>`.
4. Ficha: ícono, gráfico, capturas, descripciones, clasificación, seguridad de datos.
5. Primera subida manual del AAB a **prueba cerrada**; sumar 12 testers y sostener **14 días**.
6. Pedir acceso a producción; lanzamiento escalonado (20 % → 100 %).
7. Web: `<dominio>` pasa a ser la web principal; la URL vieja de GitHub Pages redirige.

### Terminado cuando

La app está en producción en Play Store, la web en el dominio propio, y la PWA vieja redirige.

### Costo

USD 25 una vez (Play). Mensual: el de la fase anterior. iPhone, si algún día: USD 99/año.

---

## Costos mensuales estimados (resumen)

| Concepto | Fase 0–1 | Fase 2 | Fase 3 (uso propio) | Fase 3–4 (pública, con usuarios) |
|---|---|---|---|---|
| Dominio | ~USD 1 | ~USD 1 | ~USD 1 | ~USD 1 |
| GitHub (repo público, Actions, Pages) | 0 | 0 | 0 | 0 (los datos salen de Pages) |
| Cloudflare (Workers, D1, R2, Pages, DNS) | 0 | 0 – 5 | 0 – 5 | 0 – 5 |
| Expo/EAS (plan Free) | 0 | 0 | 0 | 0 – 19 |
| Supabase | — | — | 0 | 25 |
| Open-Meteo | 0 | 0 | 0 | 0 (sin anuncios) / plan comercial (con anuncios) |
| IA del pipeline (Gemini/Groq gratis) | 0 | 0 | 0 | 0 (si la cuota no alcanza, revisar) |
| **Total mensual** | **~USD 1** | **~USD 1–6** | **~USD 1–6** | **~USD 26–50** |
| Pagos únicos | — | — | — | Play USD 25 |

## Riesgos generales

| Riesgo | Impacto | Mitigación |
|---|---|---|
| La migración se estira y quedan dos apps a medio hacer | Alto | Fase 0 primero (útil igual); PWA viva hasta que la nueva la supere; no sumar funciones durante la fase 1. |
| Cambios en las fuentes oficiales (siguen pasando) | Medio | No cambia con la migración: el pipeline es el mismo. |
| Cupos gratis de IA (Gemini ~20 pedidos/día por modelo) | Medio | Ya mitigado con la cadena Gemini → Groq y recetas sin IA. Una app pública no cambia el uso de IA (lo usa el pipeline, no los usuarios). |
| Reclamo de un titular de derechos | Alto si es pública | Sección 4 de lo legal; canal de contacto; quitar rápido lo reclamado. |
| Requisitos de Play que cambian (API objetivo cada año, verificación de desarrolladores) | Medio | Actualizar el SDK de Expo una vez por año como mínimo; revisar los avisos de Play Console. |
| Dependencia de Expo/EAS | Bajo | Todo es código abierto; se puede compilar localmente con Android Studio (`expo prebuild`). |
