# Dominio propio: gridagenda.com (fase 0.1)

Volver al [README](README.md) · [plan por fases](plan-por-fases.md).

## Estado (2026-11-25)

| Paso | Estado |
|---|---|
| Nombre y dominio elegidos; dominio comprado | Hecho |
| Código (app, Worker, workflow) | Hecho, en `main` |
| `api.gridagenda.com` y `data.gridagenda.com` | Hecho: Worker publicado en la cuenta de Cloudflare del dominio ([detalle](#dos-cuentas-de-cloudflare)) |
| Variables del repo | Hecho: `WORKER_URL`, `DATA_BASE_URL` y `APP_ORIGIN` |
| Cambio de dirección de la app a `gridagenda.com` | Hecho: dominio de GitHub Pages con HTTPS obligatorio; `www` y la dirección vieja redirigen |
| Origen autorizado de Google (carga directa en Calendar) | **Pendiente**: sumar `https://gridagenda.com` en Google Cloud → Credenciales |

Probado contra lo publicado, con tamaño de pantalla de celular: recorrido de la app en `gridagenda.com` (17 chequeos)
y mudanza de ajustes desde la dirección vieja (8 chequeos).

## Qué se decidió (2026-11-25)

| Cosa | Valor |
|---|---|
| Nombre visible | **Grid Agenda** (lema opcional: "Agenda Fierrera") |
| Dominio | **gridagenda.com**, comprado en Cloudflare Registrar (USD 11,17/año). `.app` y `.com.ar` estaban libres; no se compraron |
| Identificador de paquete (Android, fase 1) | `com.gridagenda.app` |
| Lo que **no** cambia de nombre | El repo (`agenda-deporte-motor`), el Worker (`agenda-deporte-motor`), el calendario de Google **"Deporte Motor"** (lo busca la carga directa), el nombre de los `.ics` (`X-WR-CALNAME`) y el archivo `feeds/deporte-motor.ics` (hay suscripciones hechas) |

## Las tres direcciones

| Dirección | Qué sirve | Cómo |
|---|---|---|
| `https://gridagenda.com` | La app (PWA) | Dominio propio del sitio de GitHub Pages. La dirección vieja (`ignaciogutierres1.github.io/agenda-deporte-motor/`) redirige sola |
| `https://data.gridagenda.com/<archivo>` | Los datos del pipeline: lo que hoy está en `data/<archivo>` | El Worker lee de Pages y responde con CORS abierto, `ETag` y caché de 60 s (`worker/src/data-proxy.ts`). Pages admite un solo dominio propio por sitio, por eso no es un dominio de Pages |
| `https://api.gridagenda.com/api/…` | Avisos push y proxy de tiempos en vivo | Dominio propio del Worker. La dirección `*.workers.dev` sigue activa para las apps instaladas antes |

Por qué así: la app instalada guarda direcciones. Con `data.` y `api.` propios, el día que los datos pasen a R2 o el
Worker cambie de cuenta se cambia el origen (una variable del Worker o el DNS) y ninguna app instalada se entera.

Lo que queda para después (fase 0.4 y 0.5): las rutas versionadas `data.gridagenda.com/v1/…` y `api.gridagenda.com/v1/…`.

## Cómo quedó el código

- **Un solo build para las dos direcciones.** La app se compila con base relativa (`./`) y el router usa la ruta en
  la que se abrió la página: el mismo `dist/` funciona en la raíz de `gridagenda.com` y bajo
  `/agenda-deporte-motor/`. Cambiar el dominio de Pages (o volver atrás) no exige recompilar.
- **Datos** (`app/src/lib/data.ts`): si está `VITE_DATA_BASE`, la app lee de ahí; si esa dirección falla (red, 5xx,
  cupo del Worker) lee la copia que viaja con la app en `data/`. Un 404 no se reintenta. El service worker guarda
  para uso sin conexión los archivos de las dos direcciones (`app/build/data-pattern.ts`).
- **Avisos** (`app/src/lib/push.ts`): al abrir la app con los avisos activados, si cambió el servidor de avisos se
  vuelve a registrar el dispositivo; si además cambió la clave del servidor (VAPID), se renueva la suscripción sola.
  El aviso lleva `path` (relativo a la app) y cada instalación lo abre en su propia dirección.
- **Mudanza de lo guardado** (`app/src/lib/mudanza.ts`): lo guardado en el dispositivo es por dirección, así que en
  el dominio nuevo la app arrancaría vacía. En la dirección vieja, cuando `gridagenda.com` ya sirve la app, aparece
  un aviso con el botón **Pasarme**: abre `https://gridagenda.com/#/?mudanza=…` con las categorías, pilotos y equipos
  seguidos, el tema y demás ajustes. No viajan el token de GitHub ni los avisos (se activan de nuevo).

### Variables

| Dónde | Variable | Valor |
|---|---|---|
| Repo (Actions → Variables) | `WORKER_URL` | `https://api.gridagenda.com` |
| Repo | `DATA_BASE_URL` | `https://data.gridagenda.com/` |
| Repo | `APP_ORIGIN` | `https://gridagenda.com` |
| Worker (`wrangler.jsonc`) | `DATA_BASE` | Origen de los datos: `https://gridagenda.com/data` (GitHub Pages) |
| Worker | `APP_URL` | `https://gridagenda.com/` |
| Worker | `DATA_HOSTS` | `data.gridagenda.com` |
| Worker | `ALLOWED_ORIGINS` | Incluye `https://gridagenda.com` **y** `https://ignaciogutierres1.github.io` (apps ya instaladas) |

Las tres del repo vacías = la app se comporta como antes del dominio (datos junto a la app, sin aviso de mudanza).

## Orden del cambio de dirección

El orden importa por las apps ya instaladas en la dirección vieja:

1. **Worker con `api.` y `data.`** publicados y respondiendo.
2. **Variables del repo** cargadas y una corrida de "Actualizar y publicar". La app sigue en la dirección vieja,
   ya leyendo de `data.` y `api.`.
3. **Abrir la app instalada y tocar Menú → Actualizar** en cada teléfono, *antes* del paso 4. Después del paso 4 la
   dirección vieja no puede recibir versiones nuevas (GitHub redirige también el archivo del service worker, y un
   service worker no se actualiza a través de una redirección): una instalación que no pasó por este paso sigue
   andando con su versión vieja, pero no ve el aviso de mudanza.
4. **Cambio de dirección:** en Cloudflare, DNS de la raíz hacia GitHub Pages (abajo), y en el repo *Settings → Pages
   → Custom domain* = `gridagenda.com`. Cuando GitHub emite el certificado, tildar *Enforce HTTPS*. Si el dominio
   se cargó antes que el DNS y el certificado no aparece en ~10 minutos, quitar el dominio y volver a ponerlo: eso
   repite el chequeo de DNS y el certificado sale en un minuto.
5. En el teléfono: abrir la app vieja → aviso → **Pasarme** → instalar desde `gridagenda.com` → activar los avisos
   → desinstalar la vieja.
6. Limpieza: `DATA_BASE` y `APP_URL` del Worker a `gridagenda.com`; sumar `https://gridagenda.com` como origen
   autorizado del cliente OAuth de Google (Google Cloud → Credenciales) para la carga directa en Google Calendar.

Registros DNS del paso 4 (todos **solo DNS**, nube gris, para que GitHub pueda emitir el certificado):

| Tipo | Nombre | Valor |
|---|---|---|
| A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (cuatro registros) |
| CNAME | `www` | `ignaciogutierres1.github.io` |

Importante: cargar el dominio en GitHub **antes** (o en el mismo momento) que el DNS. Un DNS apuntando a GitHub sin
sitio que lo reclame deja el dominio expuesto a que otro repositorio lo tome.

### Volver atrás

Quitar el dominio en *Settings → Pages*. La dirección vieja vuelve a servir la app al instante (mismo build) y las
instalaciones viejas vuelven a actualizarse. `data.` y `api.` no dependen de esto.

## Dos cuentas de Cloudflare

El dominio se compró en una cuenta de Cloudflare distinta de la que tenía el Worker, y un dominio propio de Worker
exige que la zona y el Worker estén en la misma cuenta (el primer intento respondió *"The zone gridagenda.com does
not exist on your account"*). Se resolvió el 2026-11-25 **publicando el Worker en la cuenta del dominio**:

| | Worker nuevo (el de `worker/wrangler.jsonc`) | Worker anterior |
|---|---|---|
| Cuenta | La del dominio | La original |
| Direcciones | `api.gridagenda.com`, `data.gridagenda.com` (sin `*.workers.dev`) | `agenda-deporte-motor.agendadeportemotor.workers.dev` |
| Suscripciones (KV `SUBS`) | Espacio nuevo, vacío al empezar | Las de antes |
| Claves de avisos (VAPID) | Nuevas | Las de antes |
| Quién lo usa | La app publicada desde ahora | Las versiones instaladas que todavía no se actualizaron |

- `npx wrangler login` en esta PC entra ahora a la cuenta del dominio: `npm run deploy -w worker` publica el Worker
  nuevo. El anterior queda publicado tal cual, sin redeploy; se puede borrar desde su cuenta cuando ya nadie use una
  versión vieja de la app (sus avisos dejan de salir solos a medida que los dispositivos se pasan).
- Al abrir la app actualizada con los avisos activados, el dispositivo detecta que cambió el servidor y su clave, y
  renueva la suscripción solo (sin volver a pedir permiso).
- Para que Cloudflare acepte el cron en una cuenta nueva hay que abrir una vez *Workers & Pages* en el panel (ahí se
  crea el subdominio `workers.dev` de la cuenta, aunque este Worker no lo use).
- Wrangler recuerda la cuenta elegida en `worker/node_modules/.cache/wrangler/wrangler-account.json`: al cambiar de
  cuenta hay que borrar ese archivo, o los comandos fallan con *Authentication error [code: 10000]*.

## Límites a tener presentes

- **Plan gratuito de Workers: 100.000 pedidos por día**, y ahora cada lectura de datos pasa por el Worker. Para uso
  propio sobra; si la app se hace pública, pasar los datos a R2 con dominio propio (sin Worker en el medio), como
  dice [arquitectura.md](arquitectura.md). Si el cupo se agota, la app usa sola la copia de `data/`.
- Los datos tardan hasta ~1 minuto más en verse (caché del borde) además de los 10 minutos de caché de Pages.
- El aviso de mudanza comprueba que `gridagenda.com` sirva la app leyendo su manifiesto desde la dirección vieja;
  funciona porque GitHub Pages responde con `Access-Control-Allow-Origin: *`. Si la web se muda a otro hosting
  mientras queden instalaciones viejas, conservar ese encabezado en `manifest.webmanifest`.
