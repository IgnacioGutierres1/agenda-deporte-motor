# Agenda Deporte Motor

Grilla de horarios de deporte motor (internacional y argentino) con **la fuente oficial de cada horario**,
resultados y campeonatos, y exportación a calendario (`.ics`, Google Calendar y suscripción).
App web instalable (PWA) en Android e iOS, con costo $0.

## Secciones de la app (diseño inspirado en FotMob)

| Sección | Qué muestra |
|---|---|
| **Agenda** | Franja de días (y "Finde"): sesiones del día agrupadas por evento; primero lo que seguís. Ícono de calendario → exportar (`.ics`, Google Calendar, suscripción). |
| **Noticias** | Notas de sitios oficiales y medios especializados (RSS): Para ti / Últimas / Por categoría. Siempre se leen en el sitio original. |
| **Categorías** | Todas las categorías (incluido el grupo Asia y Oceanía); cada una con Resumen, Calendario, Tabla de campeonato, Resultados, Plantel (pilotos, equipos, números y autos) y Noticias. |
| **Siguiendo** | Categorías, pilotos y equipos seguidos (se guardan en el dispositivo; las categorías de pilotos y equipos seguidos también van primero en la Agenda y en "Para ti") y recomendaciones "Para vos". Ficha de piloto con país, campeonatos, inscripciones, próximas y últimas carreras. |
| **Buscar** | Categorías, pilotos, equipos, circuitos, eventos y noticias; sin texto muestra "Te puede interesar". |
| Evento → **Contexto** | "Ponerme en contexto" (desde el evento, En vivo o la hoja de cada sesión): fecha N de M, qué se juega (tabla con diferencias, fechas que quedan y, en F1, MotoGP, Moto2/3, F2/F3 e IndyCar, quién puede salir campeón), formato y clases, a quién mirar, qué ya pasó en el finde y en la fecha anterior, notas recientes y fuentes. Solo datos oficiales, sin IA. |
| Equipo / Circuito | Ficha de equipo (categorías, posiciones, autos, pilotos, próximas carreras y notas) y de circuito (trazado dibujado con datos de OpenStreetMap o plano de Wikimedia Commons, ficha técnica, foto, extracto de Wikipedia, cómo llegar y todas las categorías que corren ahí). Lista de todos los circuitos por país en `/circuitos` (desde Categorías, el menú o Buscar). |
| Menú ☰ | Actualizar datos, Exportar, Auditoría de fuentes y Ajustes (tema oscuro/claro, zona horaria, cuentas). |

Datos que publica el pipeline en `data/`: `schedule.json`, `status.json`, `standings/*.json`, `results/**`,
`rosters/*.json` (listas oficiales de inscriptos), `drivers.json` (índice de pilotos armado desde tablas, resultados e inscriptos), `teams.json` (índice de equipos), `circuits.json` (ficha de cada circuito: coordenadas, datos del trazado, foto y plano, de Wikidata, Wikipedia y Wikimedia Commons), `news.json` y `feeds/deporte-motor.ics`.

## Estructura

| Carpeta | Contenido |
|---|---|
| `shared/` | Tipos, esquemas zod, horas/períodos y generador `.ics` (lo usan app y pipeline). |
| `config/` | Categorías (`series.default.json` = las 22 del gem; `series.user.json` = altas/bajas desde la app), duraciones estimadas, transmisión habitual, fuentes de descubrimiento, feeds de noticias (`news.json`), pilotos con variantes del nombre u homónimos (`driver-aliases.json`) y correcciones manuales de las fichas de circuitos (`circuits.json`: qué elemento de Wikidata es cada circuito, o `null` para no buscarlo). |
| `pipeline/` | Recolector Node + TypeScript: lectores directos (`src/adapters`), flujo genérico con IA (`src/generic`), resultados, descubrimiento. |
| `app/` | PWA en Vue 3 (Options API) + Vite. |
| `data/` | Archivos generados por el pipeline. **No editar a mano.** |
| `docs/` | Notas técnicas (`en-vivo.md`) y el plan de migración a app Android + web propia (`migracion/`, solo planificación). |

## Comandos

```bash
npm install
npm test              # Vitest en shared, pipeline y app
npm run typecheck
npm run pipeline      # corre el recolector y escribe data/  (opciones: --only=f1,tc --skip-results --skip-news --skip-circuits --dry-run)
npm run discovery     # descubrimiento de competencias nuevas
npm run news          # solo noticias: lee los feeds RSS/Atom y escribe data/news.json (--dry-run)
npm run circuits      # fichas de circuitos: completa data/circuits.json sin tope por corrida (--force, --only=monza, --table)
npm run circuits:tracks  # trazados de los circuitos desde OpenStreetMap: data/tracks/{id}.json (--limit=30 --only=id --force --dry-run)
npm run drivers:candidates  # posibles pilotos duplicados por variantes del nombre (para config/driver-aliases.json)
npm run dev           # app en modo desarrollo (sirve data/ en /data/)
npm run build         # build de producción en app/dist (incluye data/)
```

## Puesta en marcha (una sola vez, todo gratis)

### 1. Publicar en GitHub

1. Crear un repositorio **público** en GitHub (p. ej. `agenda-deporte-motor`). Público = Pages y Actions gratis.
2. Subir el código:
   ```bash
   git remote add origin https://github.com/<usuario>/agenda-deporte-motor.git
   git push -u origin main
   ```
3. En el repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. En **Settings → Actions → General → Workflow permissions** elegir **Read and write permissions**
   (el workflow commitea `data/`).
5. Pestaña **Actions → "Actualizar y publicar" → Run workflow**. Al terminar, la app queda en
   `https://<usuario>.github.io/agenda-deporte-motor/`.

### 2. Clave de Gemini (categorías sin lector propio)

1. Crear una clave gratis en <https://aistudio.google.com/apikey>.
2. En el repo → **Settings → Secrets and variables → Actions → New repository secret**:
   `GEMINI_API_KEY`.
3. Opcionales (pestaña *Variables*): `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_SEARCH_MODEL`,
   `GEMINI_MAX_CALLS`, `GEMINI_PROVIDER` (`aistudio` o `vertex`), `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`,
   `DISCOVERY_SEARCH`. Ver `.env.example`.

Sin ninguna clave de IA, las categorías con lector directo (F1, F2, F3, MotoGP, NASCAR) funcionan igual; el resto
aparece como "Error de fuente" en Auditoría.

#### Respaldo gratuito: Groq (recomendado)

El plan gratis de Gemini da unos 20 pedidos por día y por modelo, y en días con mucha actividad no alcanza.
Por eso la IA funciona como una **cadena**, siempre gratis:

1. **Gemini** (con su propio respaldo entre modelos Flash, cada uno con su cupo).
2. **Groq**, cuando Gemini agotó el cupo diario de todos sus modelos, falta su clave o falla.

Un proveedor que agota su cupo del día no se vuelve a probar en esa corrida; si ninguno puede responder, el dato
queda "a confirmar" y se reintenta en la próxima corrida. Cada dato leído con IA guarda en `source.model` qué
proveedor y modelo lo transcribió (p. ej. `groq/openai/gpt-oss-120b`), y pasa por los mismos controles contra el
documento oficial sea cual sea el proveedor.

Para activar Groq:

1. Crear una cuenta gratis (no pide tarjeta) en <https://console.groq.com> y una clave en
   <https://console.groq.com/keys>.
2. En el repo → **Settings → Secrets and variables → Actions → New repository secret**: `GROQ_API_KEY`.
3. Opcionales (pestaña *Variables*): `GROQ_MODEL` (por defecto `openai/gpt-oss-120b`), `GROQ_FALLBACK_MODELS`
   (`openai/gpt-oss-20b`), `GROQ_VISION_MODEL` (`qwen/qwen3.8-27b`, para calendarios publicados como imagen).

Diferencias con Gemini: Groq no lee PDF, así que recibe el texto que el pipeline ya extrae del PDF; las imágenes
van solo al modelo con visión y de a pocas por pedido; y como el plan gratis permite ~8 mil tokens por minuto,
los documentos largos se recortan a las partes que nombran la serie, el evento y sus fechas. La búsqueda con
Google del descubrimiento sigue siendo solo de Gemini.

> GitHub Models, que se había evaluado como otro eslabón gratuito, fue retirado por GitHub el 30/7/2026.

### 3. Instalar en el celular

- **Android**: abrir la URL en Chrome → menú → **Instalar app**.
- **iPhone**: abrir la URL en Safari → **Compartir → Agregar a inicio**.

### 4. Opcional: "Forzar actualización" y editar categorías desde la app

Crear un *fine-grained token* en GitHub (**Settings → Developer settings → Personal access tokens →
Fine-grained**), limitado a este repo, con permisos **Contents: Read and write** y **Actions: Read and write**.
Pegarlo en la app → **Ajustes**. Se guarda solo en ese dispositivo.

### 5. Opcional: carga directa en Google Calendar

1. En <https://console.cloud.google.com/> crear un proyecto y habilitar **Google Calendar API**.
2. **APIs y servicios → Pantalla de consentimiento OAuth**: tipo *Externo*, en modo *Prueba*, y agregar tu
   cuenta como usuario de prueba.
3. **Credenciales → Crear ID de cliente OAuth → Aplicación web**, con origen autorizado
   `https://<usuario>.github.io`.
4. Copiar el Client ID en la app → **Ajustes** (o como variable `GOOGLE_CLIENT_ID` del repo).
5. En Google Calendar tiene que existir un calendario llamado **Deporte Motor**.

### 6. Opcional: suscripción al calendario

En **Ajustes** está el link `webcal://…/data/feeds/deporte-motor.ics`. Agregarlo una vez en Google Calendar
(*Otros calendarios → Desde URL*) o en el iPhone (*Ajustes → Calendario → Cuentas → Agregar calendario
suscrito*). Se actualiza solo; Google refresca las suscripciones cada varias horas. Los eventos de los
próximos 60 días que todavía no tienen cronograma aparecen como evento de día completo "(horarios a confirmar)";
cuando se publican los horarios, ese evento desaparece y quedan las sesiones.

Además del calendario general hay **uno por categoría** (`data/feeds/{id}.ics`, p. ej. `feeds/f1.ics`, con el nombre
de la categoría): el enlace está en la página de cada categoría («Suscribirme al calendario de esta categoría») y, para
las categorías seguidas, en **Exportar**. El pipeline los genera para las categorías habilitadas y borra los de las
que se deshabilitan o se eliminan. La descripción de cada evento lleva la transmisión y, cuando hay un sitio o canal
oficial verificado (`shared/src/broadcast.ts`), su enlace.

### 7. Avisos y tiempos en vivo (Cloudflare Worker, gratis)

`worker/` es un Cloudflare Worker (plan gratuito) que:

- guarda las suscripciones de avisos de cada dispositivo (KV) y, cada 5 minutos, avisa las sesiones de las
  categorías seguidas (y las de los pilotos y equipos seguidos: la app manda la lista de categorías ya armada) con la anticipación elegida en *Ajustes → Avisos*;
- hace de proxy, solo para una lista cerrada de fuentes oficiales, de tiempos en vivo que no se pueden leer
  directo desde el navegador (CORS).

Publicado en `https://agenda-deporte-motor.agendadeportemotor.workers.dev`. La app lo conoce por la variable
del repo `WORKER_URL` (*Settings → Secrets and variables → Actions → Variables*).

Para volver a publicarlo después de un cambio:

```bash
npx wrangler login            # una vez por compu
npm run deploy -w worker
```

Secretos del Worker (ya cargados; solo si hay que regenerarlos): `VAPID_PRIVATE_KEY` (JWK) y `VAPID_PUBLIC_KEY`,
generados con `npx @pushforge/builder generate-vapid-keys` y cargados con `npx wrangler secret put …`.
Si se regeneran, cada dispositivo tiene que volver a activar los avisos.

En iPhone los avisos web funcionan solo con la app instalada en la pantalla de inicio (iOS 16.4 o posterior).

## Convenciones

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/es/) en español
  (`feat(pipeline): …`, `fix(app): …`, `chore: …`, `test: …`, `docs: …`).
- **Ramas**: `main` siempre estable; trabajo en `feat/<tema>` o `fix/<tema>` y merge con `--no-ff`.
- **Datos**: todo lo publicado lleva `source` (URL, tipo, método directo/IA, fecha de lectura y, si es IA, el modelo). Las horas se guardan en UTC.
- **Vue**: Options API (`defineComponent({ data, computed, methods })`), sin `<script setup>`.
