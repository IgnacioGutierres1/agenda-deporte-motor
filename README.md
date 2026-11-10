# Agenda Deporte Motor

Grilla de horarios de deporte motor (internacional y argentino) con **la fuente oficial de cada horario**,
resultados y campeonatos, y exportación a calendario (`.ics`, Google Calendar y suscripción).
App web instalable (PWA) en Android e iOS, con costo $0.

## Secciones de la app (diseño inspirado en FotMob)

| Sección | Qué muestra |
|---|---|
| **Agenda** | Franja de días (y "Finde"): sesiones del día agrupadas por evento; primero lo que seguís. Ícono de calendario → exportar (`.ics`, Google Calendar, suscripción). |
| **Noticias** | Notas de sitios oficiales y medios especializados (RSS): Para ti / Últimas / Por categoría. Siempre se leen en el sitio original. |
| **Categorías** | Todas las categorías; cada una con Resumen, Calendario, Tabla de campeonato, Resultados y Noticias. |
| **Siguiendo** | Categorías y pilotos seguidos (se guardan en el dispositivo). Ficha de piloto con campeonatos, próximas y últimas carreras. |
| **Buscar** | Categorías, pilotos, eventos/circuitos y noticias. |
| Menú ☰ | Actualizar datos, Exportar, Auditoría de fuentes y Ajustes (tema oscuro/claro, zona horaria, cuentas). |

Datos que publica el pipeline en `data/`: `schedule.json`, `status.json`, `standings/*.json`, `results/**`,
`drivers.json` (índice de pilotos armado desde tablas y resultados), `news.json` y `feeds/deporte-motor.ics`.

## Estructura

| Carpeta | Contenido |
|---|---|
| `shared/` | Tipos, esquemas zod, horas/períodos y generador `.ics` (lo usan app y pipeline). |
| `config/` | Categorías (`series.default.json` = las 22 del gem; `series.user.json` = altas/bajas desde la app), duraciones estimadas, transmisión habitual, fuentes de descubrimiento y feeds de noticias (`news.json`). |
| `pipeline/` | Recolector Node + TypeScript: lectores directos (`src/adapters`), flujo genérico con IA (`src/generic`), resultados, descubrimiento. |
| `app/` | PWA en Vue 3 (Options API) + Vite. |
| `data/` | Archivos generados por el pipeline. **No editar a mano.** |

## Comandos

```bash
npm install
npm test              # Vitest en shared, pipeline y app
npm run typecheck
npm run pipeline      # corre el recolector y escribe data/  (opciones: --only=f1,tc --skip-results --skip-news --dry-run)
npm run discovery     # descubrimiento de competencias nuevas
npm run news          # solo noticias: lee los feeds RSS/Atom y escribe data/news.json (--dry-run)
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
3. Opcionales (pestaña *Variables*): `GEMINI_MODEL`, `GEMINI_SEARCH_MODEL`, `GEMINI_MAX_CALLS`,
   `GEMINI_PROVIDER` (`aistudio` o `vertex`), `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `DISCOVERY_SEARCH`.
   Ver `.env.example`.

Sin la clave, las categorías con lector directo (F1, F2, F3, MotoGP, NASCAR) funcionan igual; el resto
aparece como "Error de fuente" en Auditoría.

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
suscrito*). Se actualiza solo; Google refresca las suscripciones cada varias horas.

## Convenciones

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/es/) en español
  (`feat(pipeline): …`, `fix(app): …`, `chore: …`, `test: …`, `docs: …`).
- **Ramas**: `main` siempre estable; trabajo en `feat/<tema>` o `fix/<tema>` y merge con `--no-ff`.
- **Datos**: todo lo publicado lleva `source` (URL, tipo, método directo/IA, fecha de lectura). Las horas se guardan en UTC.
- **Vue**: Options API (`defineComponent({ data, computed, methods })`), sin `<script setup>`.
