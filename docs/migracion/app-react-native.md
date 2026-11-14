# App en React Native (Expo)

Volver al [README](README.md). Versiones consultadas el **2026-11-14**.

## 1. Stack concreto

| Necesidad | Elección | Por qué / alternativa |
|---|---|---|
| Framework | **Expo SDK 58** (React Native 0.88, publicado el 2026-10-15) | Builds administrados (EAS), actualizaciones OTA, web desde el mismo código. Expo 58 activa R8 en los builds de Android y cambia la salida web por defecto (ver "Web"). |
| Navegación | **Expo Router** (archivos = rutas) | Las rutas actuales de `app/src/router.ts` se traducen 1:1 (tabla de la sección 4). Deep links y App Links "gratis". |
| Datos remotos | **TanStack Query v5** | Caché, reintentos, `staleTime` por tipo de archivo, recarga al volver a primer plano, `onlineManager` con NetInfo. Reemplaza los `status`/`load`/`reloadLoaded` de los stores de Pinia. |
| Estado local | **Zustand** + `persist` | Para `settings` (zona, tema, seguidos, avisos). Es el equivalente más directo a un store de Pinia con `persistStore`. Alternativa: Legend State (más rápido, menos conocido). |
| Lógica de dominio | **`shared/` + `@dm/core`** (la lógica pura de `app/src/lib` movida a un paquete) | Se testea con Vitest como hoy; las dos apps (Vue y Expo) la importan. |
| Estilos | `StyleSheet` + *tokens* de tema (colores, espacios, tipografías) en un `theme.ts` | Traducción directa de las variables CSS de `styles.css`. Alternativas: **Unistyles 3** (temas y *breakpoints* sin re-render), NativeWind (Tailwind; útil si te gusta escribir clases). Evitar kits pesados (NativeBase, etc.). |
| Listas | **FlashList** (Shopify) | Agenda, noticias, pilotos y resultados son listas largas. `SectionList` sirve para empezar. |
| Pestañas internas | `react-native-tab-view` / Material Top Tabs de React Navigation | Reemplaza la directiva `v-tab-strip` (pestañas desplazables con la activa centrada). |
| Hojas modales | `@gorhom/bottom-sheet` | Reemplaza `BottomSheet.vue` (`SessionSheet`, filtros). |
| SVG | **`react-native-svg`** | `TrackOutline` (los `paths` de `tracks/{id}.json` ya son strings `d` de SVG: van directo a `<Path d=… />`), `WeatherIcon`, `AppIcon`, termómetro de `EventResults`. En web, `react-native-svg` renderiza SVG real. |
| Íconos | Tabla actual de `AppIcon` portada a SVG, o `@expo/vector-icons` | Mantener los propios conserva la identidad visual. |
| Imágenes | **`expo-image`** | Caché en disco de fotos de Commons, `og:image` de noticias y mapas de etapas. |
| Mapas | **Ninguno embebido** (como hoy: enlaces a Google Maps/OSM con `Linking`) | Si algún día se embebe: MapLibre React Native (teselas OSM, sin clave) antes que `react-native-maps` (requiere clave de Google Maps en Android). |
| Avisos | **`expo-notifications`** + Expo Push (FCM v1 por detrás) | Solo Android/iOS: **no soporta web**. La web conserva Web Push (VAPID) con su Service Worker. |
| Almacenamiento | AsyncStorage (preferencias), `expo-file-system` o `expo-sqlite` (caché de datos) | Ver [api.md, "Sin conexión"](api.md#4-sin-conexión). `react-native-mmkv` es más rápido pero no corre en Expo Go (sí en *development builds*, que igual hacen falta por los avisos). |
| Calendario | **`expo-calendar`** (escribe en el calendario del teléfono) + `Linking.openURL('webcal://…')` + `.ics` con `expo-file-system` + `expo-sharing` | En Android reemplaza el flujo de Google Identity Services: el calendario del teléfono ya sincroniza con Google. GIS queda solo en la web. |
| Abrir notas y fuentes | **`expo-web-browser`** (Custom Tabs) | Las notas "siempre se leen en el sitio original": Custom Tabs lo hace sin salir de la app. |
| Portapapeles / compartir | `expo-clipboard`, `expo-sharing`, `Share` de RN | Reemplazan `navigator.clipboard`, `navigator.share` y `download.ts`. |
| Zona horaria del dispositivo | `expo-localization` (`getCalendars()[0].timeZone`) | Valor inicial de `settings.timeZone` (hoy `AR_TZ` fijo). |
| Actualizaciones | **`expo-updates`** (EAS Update) | Reemplaza `appUpdate.ts` (Service Worker en espera). 1.000 usuarios activos/mes gratis. |
| Fechas | `luxon` (como hoy) | Ver spike: depende de `Intl` de Hermes. |
| Tests | Vitest (lógica pura, sin cambios) + **Jest con `jest-expo`** + React Native Testing Library (componentes) | Expo recomienda Jest para componentes RN. |
| Pruebas de humo | **Maestro** (flujos YAML sobre el APK o un emulador) | Equivalente a los recorridos con Playwright que hacés hoy sobre la PWA. Para la web de Expo, Playwright sigue sirviendo. |
| Errores en producción | Sentry (`@sentry/react-native`, plan gratis para desarrolladores) | Opcional. Si se usa, declararlo en el formulario de seguridad de datos. |
| Builds | **EAS Build** (gratis: 15 builds de Android, cola de baja prioridad, 45 min de tope) | O build local con Android Studio: `npx expo prebuild` + `npx expo run:android --variant release`. |

### Web

- Expo Router web con **`"web": { "output": "static" }`** en `app.json`: genera HTML por ruta y archivos que sirve
  cualquier hosting estático (Cloudflare Pages/Workers Static Assets). **Ojo:** en SDK 58 el valor por defecto
  pasó a ser `server` (renderiza en cada pedido y necesita un servidor), así que hay que fijarlo a mano.
- Las rutas con parámetros (`/evento/[eventId]`) no se pueden pre-generar todas: o se generan con
  `generateStaticParams` (leyendo `schedule.json` en el build) o se sirve el *fallback* de SPA para esas rutas.
  Lo primero da URLs compartibles con vista previa (título y descripción del evento): vale la pena.
- Diferencias a resolver con archivos por plataforma (`push.web.ts` / `push.native.ts`, etc.): avisos, calendario,
  descarga de `.ics`, almacenamiento, tiempos en vivo (proxy en web, directo en nativo).
- En SDK 58 Expo Router ya no da los márgenes seguros en web: usar `env(safe-area-inset-*)` en CSS, como hoy.

### Estructura del repo propuesta

```
shared/        (igual)                    @dm/shared
pipeline/      (igual)                    @dm/pipeline
worker/        (igual, extendido)         @dm/worker
core/          (nuevo, fase 0)            @dm/core   ← lógica pura de app/src/lib + gcal + github/user-config
app/           (PWA Vue, se mantiene)     @dm/app
mobile/        (nuevo, fase 1)            @dm/mobile ← Expo (Android + web)
  app/                  rutas de Expo Router
    (tabs)/_layout.tsx  barra inferior: Agenda, Noticias, Categorías, Siguiendo, Buscar
    (tabs)/index.tsx    Agenda
    categoria/[seriesId].tsx
    evento/[eventId].tsx
    …
  src/data/             getDataFile, caché, hooks de TanStack Query
  src/state/            settings (Zustand)
  src/platform/         push.native.ts / push.web.ts, calendar, storage, live
  src/ui/               componentes
  src/theme.ts          tokens (de styles.css)
```

Expo detecta solo los monorepos con npm workspaces (desde el SDK 52 no hace falta tocar `metro.config.js` para el
caso común). `mobile/` usa `"@dm/shared": "*"` y `"@dm/core": "*"` como `app/`.

<a id="spike"></a>

## 2. Spike de compatibilidad (hacer primero, medio día)

Antes de comprometer la migración, crear `mobile/` vacío con Expo y una sola pantalla que importe `@dm/shared` y
muestre la agenda de hoy. Verificar:

| Punto | Por qué puede fallar | Plan B |
|---|---|---|
| Imports con extensión `.ts` (`'./types.ts'`) | Toda `shared/` los usa (`allowImportingTsExtensions`). Metro resuelve rutas exactas, debería andar. | Ajustar `resolver.sourceExts` o compilar `shared/` a JS con `tsc`. |
| `import aliasConfig from '../../config/driver-aliases.json' with { type: 'json' }` (`shared/src/drivers.ts`) | Atributos de import: Babel necesita el plugin de sintaxis; además el archivo está fuera de `shared/`. | Sacar los alias a `shared/src/driver-aliases.ts` generado, o inyectarlos (la app no los necesita: los ids ya vienen resueltos). |
| `BigInt` y `TextEncoder` (`stableHash` en `hash.ts`) | Hermes los soporta en versiones recientes. La app casi no llama `stableHash` (los ids vienen hechos). | Separar `stableHash` en un módulo que la app no importe. |
| `luxon` con zonas IANA (`setZone('Asia/Qatar')`, `toFormat`) | Depende de `Intl.DateTimeFormat` con `timeZone` y `formatToParts` en Hermes (Android). | Polyfills `@formatjs/intl-datetimeformat` + datos de zonas, o reemplazar por `Temporal` (polyfill) en los puntos críticos. |
| `zod` | Funciona en RN. | — |
| Tamaño del bundle | `shared/src/index.ts` exporta todo (esquemas, lectores en vivo, `.ics`). Metro no hace *tree shaking* completo. | Imports por subruta (`@dm/shared/types`, `@dm/shared/period`) agregando `exports` en `shared/package.json` (ya existe `./live-sources`). |
| Rendimiento de `schedule.json` (1,2 MB) | Parseo y agrupado en el hilo de JS al abrir. | `upcoming.json` para la primera pantalla; el resto en segundo plano. |

## 3. Inventario de `app/src`

Portabilidad: **TS** = TypeScript puro, se mueve tal cual a `@dm/core`. **TS+A** = lógica portable con una parte
de plataforma que hay que separar. **UI** = reescribir la interfaz en RN.

### 3.1 Lógica (`lib/`, `gcal/`, `github/`)

| Archivo | Qué hace | Plataforma | Portabilidad | Destino |
|---|---|---|---|---|
| `lib/agenda.ts` | Franja de días, finde, agrupación por evento | luxon | TS | `@dm/core` |
| `lib/grid.ts` | Grilla, auditoría, colores, orden de categorías | — | TS | `@dm/core` |
| `lib/context.ts` | Ficha "Contexto" (724 líneas) | — | TS | `@dm/core` |
| `lib/stages.ts` | Itinerarios de rally | — | TS | `@dm/core` |
| `lib/search.ts` | Búsqueda sin acentos y tolerante | — | TS | `@dm/core` |
| `lib/recommend.ts` | Recomendaciones deterministas | — | TS | `@dm/core` |
| `lib/podium.ts` | Podio, vuelta rápida, sesión principal | — | TS | `@dm/core` |
| `lib/roster.ts`, `lib/teams.ts`, `lib/upcoming.ts`, `lib/season.ts`, `lib/seasonStats.ts`, `lib/standingsTables.ts`, `lib/onboarding.ts` | Plantel, equipos, próximas, temporada, mosaicos, pastillas de tablas, "Empezá por acá" | — | TS | `@dm/core` |
| `lib/countdown.ts`, `lib/format.ts`, `lib/conditions.ts`, `lib/sources.ts`, `lib/broadcast.ts`, `lib/circuits.ts`, `lib/circuitInfo.ts` | Textos y cálculos de presentación | — | TS | `@dm/core` |
| `lib/clock.ts` | Reloj por minuto que se pausa en segundo plano | `document` inyectable | TS+A | `@dm/core` + adaptador con `AppState` |
| `lib/data.ts` | `fetchData`, URLs, webcal | `import.meta.env.BASE_URL`, `window.location` | TS+A | Base URL inyectable; en Expo, `getDataFile` (ver [api.md](api.md#3-cómo-lee-la-app)) |
| `lib/storage.ts` | `localStorage` tolerante + `persistStore` de Pinia | `localStorage`, Pinia | TS+A | Zustand `persist` |
| `lib/weather.ts` | Cliente de Open-Meteo + caché + lógica de clima (862 líneas) | `localStorage`, `fetch` | TS+A | Separar: lógica pura → `@dm/core`; caché → adaptador |
| `lib/live.ts` | Fuentes y lectores en vivo | `fetch`, `WORKER_URL` | TS+A | En nativo, sin proxy |
| `lib/push.ts` | Web Push | Service Worker, `Notification`, `PushManager` | TS+A (casi reescritura) | `push.web.ts` (esto) + `push.native.ts` (expo-notifications) |
| `lib/download.ts` | Descargar/compartir `.ics`, copiar | `document`, `Blob`/`File`, `navigator` | TS+A | `expo-sharing`, `expo-clipboard` |
| `lib/refresh.ts` | "Actualizar" sobre todos los stores | Pinia | TS+A | `queryClient.invalidateQueries()` |
| `lib/searchContext.ts` | Contexto de relevancia desde stores | Pinia | TS+A | Recibir datos por parámetro |
| `lib/navState.ts` | Marca "no encontrado" | `reactive` de Vue | TS+A | Estado de la pantalla |
| `lib/appUpdate.ts` | Versión nueva de la PWA | Service Worker | Se descarta en nativo | `expo-updates` |
| `lib/install.ts` | `beforeinstallprompt` | `window` | Se descarta | — |
| `lib/tabStrip.ts` | Directiva `v-tab-strip` | DOM, `ResizeObserver`, `matchMedia` | UI | Componente de pestañas RN |
| `lib/visible.ts` | Aviso al entrar en pantalla | `IntersectionObserver` | UI | `onViewableItemsChanged` de FlashList |
| `gcal/api.ts`, `gcal/audit.ts`, `gcal/mapping.ts`, `gcal/sync.ts` | Cliente REST, auditoría y sincronización con Google Calendar | `fetch` | TS | `@dm/core` (solo web) |
| `gcal/gis.ts` | Login con Google Identity Services | `window`, `document` | Solo web | En Android, `expo-calendar` |
| `github/client.ts` | API de contenidos y workflow de GitHub | `fetch`, `btoa` | TS+A | `@dm/core` (polyfill de `btoa` o `Buffer`) |
| `github/user-config.ts` | Cambios puros de `series.user.json` | — | TS | `@dm/core` |

### 3.2 Stores (Pinia → TanStack Query + Zustand)

| Store | Datos que pide | Equivalente |
|---|---|---|
| `schedule.ts` | `schedule.json`, `status.json`; período, grilla, agenda | `useSchedule()`, `useStatus()` + selectores puros (`agendaPeriod`, `groupByEvent`…) con `useMemo`. El período elegido y `excludedIds` van a Zustand. |
| `settings.ts` | — (preferencias) | `useSettings` (Zustand persistido). `parseRepo`, `syncRefs`, `migrateSettings`, `followedSeriesIds` → funciones puras en `@dm/core`. |
| `results.ts` | `standings/{id}.json`, `results/{serie}/{evento}.json` | `useStandings(id)`, `useEventResults(serie, evento)` |
| `rosters.ts` | `rosters/{id}.json` | `useRoster(id)` |
| `drivers.ts` | `drivers-index.json` (o `drivers.json`), `drivers/{shard}.json` | `useDriversIndex()`, `useDriver(id)` (con `driverShardPath`). Sacar el `import()` de `DriverView.vue` (acople inverso). |
| `teams.ts` | `teams.json` (o `deriveTeams`) | `useTeams()` |
| `news.ts` | `news.json` | `useNews()`; `newsForSeries`/`newsForDriver` → `@dm/core` |
| `stages.ts` | `stages/{serie}/{evento}.json` | `useStages(serie, evento)` |
| `circuitInfo.ts` | `circuits.json`, `tracks/{id}.json` | `useCircuits()`, `useTrack(id)` (`staleTime` 7 días) |
| `weather.ts` | Open-Meteo vía `lib/weather` | `useForecast(lat, lon)` (`staleTime` 1 h, `gcTime` 12 h) |

### 3.3 Pantallas y componentes

Rutas (todas **UI**, se reescriben; la lógica que contienen se extrae antes, ver sección 5):

| Vue | Expo Router | Notas |
|---|---|---|
| `AgendaView.vue` (`/`) | `app/(tabs)/index.tsx` | Franja de días (pestañas desplazables), tarjetas por evento, botón "Hoy". La geometría con `getBoundingClientRect` pasa a `onLayout`/`scrollToIndex`. |
| `NewsView.vue` (`/noticias`) | `app/(tabs)/noticias.tsx` | Pestañas Para ti / Últimas / Por categoría. |
| `CategoriesView.vue` (`/categorias`) | `app/(tabs)/categorias.tsx` | |
| `FollowingView.vue` (`/siguiendo`) | `app/(tabs)/siguiendo.tsx` | |
| `SearchView.vue` (`/buscar`) | `app/(tabs)/buscar.tsx` | Búsquedas recientes en AsyncStorage. |
| `CategoryView.vue` (`/categoria/:seriesId`) | `app/categoria/[seriesId].tsx` | 6 pestañas; `?tab=` → `useLocalSearchParams()`. |
| `EventView.vue` (`/evento/:eventId`) | `app/evento/[eventId].tsx` | Pestañas Horarios/Etapas/Contexto/Resultados/Tabla. |
| `DriverView.vue` (`/piloto/:driverId`) | `app/piloto/[driverId].tsx` | |
| `TeamView.vue` (`/equipo/:teamId`) | `app/equipo/[teamId].tsx` | |
| `CircuitView.vue` (`/circuito/:circuitId`) | `app/circuito/[circuitId].tsx` | |
| `CircuitsView.vue` (`/circuitos`) | `app/circuitos.tsx` | |
| `LiveView.vue` (`/en-vivo`) | `app/en-vivo.tsx` | Polling con `AppState` en vez de `visibilitychange`. |
| `ExportView.vue` (`/exportar`) | `app/exportar.tsx` | Nativo: `expo-calendar` + webcal + compartir `.ics`. Web: como hoy. |
| `AuditView.vue` (`/auditoria`) | `app/auditoria.tsx` | |
| `SettingsView.vue` (`/ajustes`) | `app/ajustes.tsx` | Sacar "Instalar app" en nativo; avisos con `expo-notifications`. |
| `App.vue` | `app/_layout.tsx` + `app/(tabs)/_layout.tsx` | Encabezado, barra inferior, menú, reloj, recarga al volver. |
| Redirección `/campeonatos/:seriesId?` | `app/campeonatos/[[...seriesId]].tsx` con `<Redirect>` | Solo si hay enlaces viejos compartidos. |

Componentes (todos **UI**). Agrupados por esfuerzo:

| Esfuerzo | Componentes |
|---|---|
| Bajo (presentación simple) | `SeriesCrest`, `SeriesRow`, `SurfaceBadge`, `DriverAvatar`, `SourceLink`, `CountdownBadge`, `DataState`, `FollowButton`, `PodiumLine`, `PendingList`, `UpcomingList`, `RosterCarRow`, `CircuitRow`, `WeatherStats`, `SessionWeatherMark`, `BroadcastLinks`, `NotFoundCard`, `SourceProblem` |
| Medio | `EventCard`, `NewsList`, `StandingsPanel`, `RosterPanel`, `SeasonStatsCard`, `RecommendationsCard`, `StarterPack`, `LiveBoardTable`, `LiveSessionCard`, `NotificationsCard`, `CalendarSubscribe`, `PeriodPicker`, `EventWeather`, `SessionWeather`, `WeatherCard`, `StageMap`, `CircuitFigure` |
| Alto | `ContextPanel` (718 líneas), `StagesPanel` (713), `EventResults` (380), `SessionSheet` + `BottomSheet` (hoja modal), `TrackOutline` (SVG + escala), `WeatherIcon`/`AppIcon` (tablas de paths → mover a `.ts` de datos) |

CSS que importa reproducir: encabezados *sticky* (`.app-header`, `.page-tabs`, `.strip-bar`, encabezados de día y
de tabla → `stickyHeaderIndices` o `SectionList` con `stickySectionHeadersEnabled`), degradés en los bordes de las
pestañas, tema por `data-theme` + `prefers-color-scheme` (→ `useColorScheme()`), `prefers-reduced-motion` (→
`AccessibilityInfo.isReduceMotionEnabled`), *line-clamp* (→ `numberOfLines`), márgenes seguros
(`react-native-safe-area-context`). No hay `v-html` ni *scroll-snap*.

## 4. Orden sugerido de porteo

1. **Esqueleto**: `mobile/` con Expo Router, tema (tokens), barra inferior con las 5 pestañas vacías, capa de datos
   (`getDataFile` + TanStack Query + manifiesto) y `settings` en Zustand. Build de desarrollo instalado en tu
   teléfono.
2. **Agenda** (`AgendaView` + `EventCard` + `SeriesCrest` + `CountdownBadge`): es la pantalla que más se usa y
   prueba fechas, zonas, listas largas y la caché sin conexión.
3. **Evento** (horarios, `SessionSheet`, resultados, podio) y **Categoría** (calendario, tabla, resultados).
4. **Siguiendo** + seguir categorías/pilotos/equipos (Zustand persistido) + **Buscar**.
5. **Avisos** (`expo-notifications` + Worker): ver fase 2 del plan.
6. **Piloto**, **Equipo**, **Circuito** (`TrackOutline` con `react-native-svg`), **Circuitos**.
7. **Noticias** (Custom Tabs), **En vivo**, **Clima**.
8. **Contexto** y **Etapas** (las dos más largas; la lógica ya está en `lib/context.ts` y `lib/stages.ts`).
9. **Exportar** (`expo-calendar`, webcal, compartir `.ics`), **Auditoría**, **Ajustes** (incluido "Avanzado
   (dueño)" con el token de GitHub, guardado con `expo-secure-store` en lugar de texto plano).
10. **Web**: revisar cada pantalla en el navegador, `output: "static"`, `generateStaticParams` para eventos y
    categorías, Web Push.

Criterio para dar una pantalla por terminada: mismos datos que la PWA para 3 casos reales (un finde de F1, uno de
TC, un rally), funciona sin conexión con datos guardados, y pasa un flujo de Maestro.

## 5. Qué preparar en el código actual ANTES de migrar (fase 0)

Lista de tareas, **sin hacerlas todavía**. Todas son útiles aunque nunca se migre (mejoran tests y orden), y
ninguna cambia lo que ve el usuario.

### 5.1 Paquete de lógica pura

- [ ] Crear el workspace `core/` (`@dm/core`) y mover ahí los archivos marcados **TS** en 3.1 (con sus tests de
      `app/test`). `app/` pasa a importarlos de `@dm/core`.
- [ ] Mover a `@dm/core` las funciones puras que hoy viven en stores: `parseRepo`, `syncRefs`, `migrateSettings` y el
      cálculo de `followedSeriesIds`/`notifySeriesIds` (`stores/settings.ts`); `newsForSeries`/`newsForDriver`
      (`stores/news.ts`); los getters de `stores/schedule.ts` que son cálculos (circuitos, período, grilla).
- [ ] `lib/searchContext.ts` y `lib/refresh.ts`: que reciban los datos o callbacks por parámetro en vez de importar
      stores.
- [ ] `stores/drivers.ts`: quitar el `import('../views/DriverView.vue')` (precarga de la pantalla desde un store).

### 5.2 Separar plataforma de lógica

- [ ] `lib/weather.ts` (862 líneas): separar en `weather-core.ts` (códigos WMO, resumen por sesión, pronóstico por
      día, temperatura de pista estimada) y `weather-client.ts` (fetch + caché en `localStorage`).
- [ ] `lib/data.ts`: base de datos inyectable (`configureData({ baseUrl })`) en lugar de `import.meta.env.BASE_URL`
      y `window.location`.
- [ ] `lib/storage.ts`: interfaz `KeyValueStore { get, set, remove }` con implementación `localStorage`; `persistStore`
      la recibe por parámetro.
- [ ] `lib/push.ts`: separar `pushPrefsFromSettings()` (puro) de la parte Web Push.
- [ ] `lib/clock.ts`: que reciba el "estado de visibilidad" por parámetro (ya es inyectable: confirmarlo con un test).
- [ ] `lib/live.ts`: que el "pasar por proxy" sea una opción (`viaProxy: boolean`) para poder apagarlo en nativo.

### 5.3 Sacar lógica de los componentes (de más a menos)

| Componente | Lógica a mover (computed/methods) | ~líneas | Destino |
|---|---|---|---|
| `components/StagesPanel.vue` | `rowView`, `blocks`, `tiles`, `nowRow`/`nowLabel`, textos con género | 85 | `lib/stages.ts` |
| `views/ExportView.vue` | `icsContent` (GridItem → `IcsEventInput`), `range`/`actualRange`/`extraTime`; orquestación `run`/`loadToGoogle`/`fixAll`/`removeExtras`/`doAudit` | 85 | `lib/export.ts` + `gcal/sync.ts` |
| `components/ContextPanel.vue` | `raceRows`, `watch` (a quién mirar), `news` (palabras clave), `sources`, `racesAfterText`, `circuitCredit`, `loadAll`/`loadPrevious` (qué descargar) | 80 | `lib/context.ts` |
| `views/AgendaView.vue` | `nextSessionId`, `nextWhen`, `stageEvents`/`stageCards`/`stageEventIds`, `pendingSplit`, `nextFollowed`(`When`), `summary` | 80 | `lib/agenda.ts` |
| `views/FollowingView.vue` | `driverCards`, `teamCards`, `cards`, `nextText`, `entrySummary`, `teamSummary`, `whenText` | 70 | `lib/following.ts` |
| `views/SettingsView.vue` | `zoneOptions`, `visibleCount`/`enabledCount`/`setGroupVisible`/`effectiveEnabled`, `repoChange`/`addCategory` | 65 | `lib/settings.ts` + `github/user-config.ts` |
| `views/SearchView.vue` | `eventHits`, `suggestion` ("¿Quisiste decir…?"), `teamSummary`, `circuitSummary`, `entrySummary`, `remember` | 60 | `lib/search.ts` |
| `views/CircuitView.vue` + `CircuitsView.vue` | `rows`/`upcoming`/`past`, `photoRatio`, `todayByZone`, `countText`, `matches`, `nextText` | 60 | `lib/circuitInfo.ts` |
| `views/EventView.vue` | `items` (duplica `grid.ts`), `tabs`, `state`, `winner`/`allFinishedWithResults`/`nextItem` | 55 | `lib/event.ts` (y quitar la duplicación) |
| `components/WeatherCard.vue` | `wanted`, `current`, `currentStats`, `days` | 50 | `weather-core.ts` |
| `views/DriverView.vue` | estados de carga, `entries` con `standingsSeason`, `recent`, `subtitle`/`mainNumber` | 45 | `lib/driver.ts` |
| `views/CategoryView.vue` | `events`, `nextText`, `recent`/`withResults`, `statusBadge`, `showRound`, `isPast` | 40 | `lib/category.ts` |
| `components/SessionWeather.vue` + `SessionWeatherMark.vue` | `stats`, `rainText`, `range`, `label` | 35 | `weather-core.ts` |
| `components/StandingsPanel.vue` + `RosterPanel.vue` | `rowLink`/`teamTableLink`/`driverLink`/`isTeams` (heurísticas por título), *fallback* desde tablas, `summary` | 45 | `lib/standingsTables.ts`, `lib/roster.ts` |
| `components/NotFoundCard.vue`, `EventCard.vue` | `suggestions` desde el slug; `dayGroups` | 40 | `lib/search.ts`, `lib/agenda.ts` |
| Menores | `LiveView` (ventana −12/+24 h), `NewsView.seriesWithNews`, `App.vue` (`liveCount`, `pushPrefsKey`), `LiveSessionCard.poll`, `NotificationsCard`, `LiveBoardTable` | ~80 | `lib/live.ts` y afines |

Total aproximado: **~1.000 líneas** de lógica a mover, cada bloque con su test en Vitest. Regla: el componente queda
con datos de entrada, llamadas a funciones de `lib/` y plantilla; nada de `filter/sort/map` con reglas de negocio.

### 5.4 Datos y contrato

- [ ] Sumar `season?: number` a `MotorEvent` (aditivo) desde el pipeline.
- [ ] Generar `manifest.json` y `upcoming.json` en el pipeline (ver [api.md](api.md)).
- [ ] Test de contrato "congelado" de `v1` en `shared/`.
- [ ] `exports` por subruta en `shared/package.json` (`./types`, `./period`, `./time`, `./ics`, `./drivers`…).
- [ ] Mover los alias de pilotos a un `.ts` generado o sacar su import del camino de la app (spike).
- [ ] `WeatherIcon` y `AppIcon`: tablas de paths a archivos `.ts` de datos (las reusan las dos apps).
- [ ] Tokens de diseño: extraer las variables de `styles.css` (colores de los dos temas, espacios, radios,
      tipografías) a `core/src/theme-tokens.ts`; `styles.css` las sigue usando vía variables CSS generadas o
      copiadas.

### 5.5 Worker

- [ ] Rutas `/v1/…` además de `/api/…`.
- [ ] Mandar `path` sin hash (`/evento/:id`) además de la URL con hash en el payload.
- [ ] Pasar las suscripciones de una clave de KV a D1 (o, mínimo, una clave por dispositivo en KV para que dos
      altas simultáneas no se pisen).
