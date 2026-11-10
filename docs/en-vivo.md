# En vivo: fuentes de tiempos

Esta nota resume lo que se verificó el 2026-11-10. El código está en `shared/src/live-*.ts` y el formato común es `LiveBoard`, definido en `shared/src/live.ts`.

## Cómo se usa desde la app

1. `liveUpstreams(seriesId)` devuelve qué URL pedir, si hay que pasar por el proxy (`viaProxy`) y cada cuántos segundos (`pollSeconds`). Si devuelve `[]`, no hay una fuente JSON utilizable y se muestra sólo el enlace `LIVE_SOURCES[seriesId].officialUrl` ("Ver tiempos oficiales"), con `officialNote` como aclaración.
2. Con `kind: 'board'`, la respuesta se pasa directo al lector: `parseNascarLive(json, new Date())` o `parseMotogpLive(json, new Date())`.
3. Con `kind: 'speedhive-org-events'` hay que encadenar tres pedidos, todos por el proxy:
   1. Lista de eventos de la organización → `pickSpeedhiveEvents(json, LIVE_SOURCES[id].speedhive, now)`.
   2. `speedhiveEventUrl(evento.id)` → `pickSpeedhiveSessions(json, selector, now)`.
   3. `speedhiveClassificationUrl(sesion.id)` → `parseSpeedhiveClassification(json, now, { seriesId, eventName, session })`.

   Si la primera sesión vuelve sin filas (`status: 'unknown'`), es porque todavía no la subieron: hay que probar con la siguiente.
4. Los lectores no lanzan errores. Devuelven `null` cuando la entrada no sirve o no hay ninguna sesión cargada. Por ejemplo, el feed de NASCAR viene vacío entre fines de semana.
5. Un feed puede traer otra categoría. NASCAR tiene un solo feed para Cup, O'Reilly y Truck, y MotoGP uno solo para las tres clases. Hay que comparar `board.seriesId` con la categoría que se está mirando y, si no coincide, decir "sin sesión en vivo".

## Fuentes

### NASCAR (Cup, O'Reilly, Truck)

- **Endpoint:** `GET https://cf.nascar.com/live/feeds/live-feed.json`.
- **CORS:** abierto (`Access-Control-Allow-Origin: *`), así que se pide directo, sin proxy.
- **Categoría:** `series_id` 1 = Cup, 2 = O'Reilly (ex Xfinity), 3 = Truck. Se confirmó con `cacher/2026/race_list_basic.json`.
- **Banderas (`flag_state`):**
  - 1 verde.
  - 2 amarilla.
  - 3 roja.
  - 4 cuadros.
  - 8 previa (vuelta 0).
  - 9 sin sesión o sesión terminada.

  Los códigos 1, 2, 4 y 8 se verificaron en `lap-times.json` de tres carreras de 2026. El 3 y el 5 (blanca) siguen la convención y no se pudieron ver.
- **Autos:** `status` 1 = en carrera, 3 = fuera. En `delta`, un valor mayor que 0 son segundos detrás del líder y uno menor que 0 son vueltas abajo. `interval` no viene en el feed y se calcula a partir de `delta`.
- **Boxes:** se marca `inPit` sólo con la sesión en vivo y `is_on_track: false`.
- **Polling:** 10 s.
- **Feed archivado:** existe `https://cf.nascar.com/live/feeds/series_{s}/{race_id}/live_feed.json`, que es de donde sale la fixture. No se usa en la app porque su CORS no fue verificado.

### MotoGP, Moto2, Moto3

- **Endpoint:** `GET https://api.motogp.pulselive.com/motogp/v1/timing-gateway/livetiming-lite`. Es el mismo que usa el widget gratuito de motogp.com, que consulta cada 30 s.
- **CORS:** responde 403 "Invalid CORS request" cuando el pedido trae `Origin`, así que **va por el proxy**.
- **Límite:** cabecera `x-ratelimit-limit: 1000;w=60`.
- **Sesión que devuelve:** la sesión en curso o, si no hay, la última disputada. Hoy devolvía la carrera de Qatar del 08/11 con `status: 'finished'`. `motogpSessionDate(json)` da la fecha, para decidir si mostrarla como "última sesión".
- **Estado (`session_status_id`):** N = previa, S = en curso, I = interrumpida (bandera roja), F = terminada. Las constantes salen del bundle de motogp.com.
- **Carreras (RAC/SPR):** `remaining` son vueltas restantes y `lap_time` es el tiempo total.
- **Prácticas y clasificación:** `remaining` son segundos y `lap_time` es la mejor vuelta.
- **Polling:** 15 s.
- **Enlace oficial:** TimingPass, que es pago.

### Speedhive / MyLaps (categorías argentinas)

- **Tiempo real:** **no es viable.** `lt-api.speedhive.com` (`/api/events/{id}/active`, `/sessions/{id}/data`) responde 401 "API key incorrect or expired", y las actualizaciones llegan por notificaciones push (`notifications.speedhive.com`). Usarlo implicaría saltear una autenticación, así que se descartó. Para el vivo queda sólo el enlace oficial.
- **Resultados (API pública):** `https://eventresults-api.speedhive.com/api/v0.2.3/eventresults/…` devuelve JSON sin autenticación. Con `Origin` responde 403, así que **va por el proxy**. Los cronometradores (software Orbits) suben cada sesión al terminar. El tablero sale siempre con `status: 'finished'`: es la **última sesión publicada**, no vivo.
- **Organizaciones verificadas:**

  | Organización | id | Qué sube |
  |---|---|---|
  | REALTIME GROUP SRL | 318672 | TC2000 (grupo "TC2000"), Top Race, Fórmula Nacional, TCR South America. Confiable. |
  | Tiempos crono | 381036 | APAT TN (eventos "APAT TN - FECHA n", grupos "TN CLASE 2" y "TN CLASE 3"), APTP Turismo Pista (eventos "APTP - FECHA n", grupos "TP CLASE 1/2/3"), regionales ACTC. Confiable. |
  | ACTC | 265199 | Algunos eventos de TC, TC Pista, TC Mouras y TC Pick Up. **Irregular**: faltan fechas y hay sesiones de prueba. Por eso `reliable: false`. |

- **Hora de las sesiones:** `startTime` viene en hora local sin zona y se interpreta en America/Argentina/Buenos_Aires.
- **Sesiones descartadas:** las "generales" con fecha 1970.
- **Polling:** 120 s. Los resultados cambian, como mucho, una vez por sesión.

### Sin fuente JSON (sólo enlace)

- **F1:** el live timing requiere F1 TV o la app.
- **ACTC (TC, TC Pista, TC Mouras, TC Pick Up):** el vivo propio está en `tiempos.actc.org.ar/live/{tc,tcp,tcm,tcpk}`. Funciona con Socket.IO y su API REST responde "No autorizado".
- **Resto de las categorías:** IndyCar, SRO, DTM, NLS, IMSA, WEC/ELMS, 24H Series, GT Open, F2/F3/F1 Academy y Porsche Supercup no tienen una fuente pública verificada. Ver la tabla.

## Lista permitida del proxy (`PROXY_ALLOWLIST`)

Sólo `GET`, sin cabeceras del cliente ni cookies. Las URL tienen que coincidir completas, incluida la query:

```
^https://api\.motogp\.pulselive\.com/motogp/v1/timing-gateway/livetiming-lite$
^https://eventresults-api\.speedhive\.com/api/v0\.2\.3/eventresults/organizations/(?:265199|318672|381036)/events\?count=\d{1,2}$
^https://eventresults-api\.speedhive\.com/api/v0\.2\.3/eventresults/events/\d{1,10}\?sessions=true$
^https://eventresults-api\.speedhive\.com/api/v0\.2\.3/eventresults/sessions/\d{1,12}/classification$
```

`isProxyAllowed(url)` aplica la misma lista. Recomendaciones para el Worker:

- Cachear 5 s la respuesta de MotoGP y 60 s las de Speedhive, para que muchos usuarios no multipliquen los pedidos.
- Enviar un `User-Agent` propio, sin `Origin`.
- No reenviar cookies.

## Páginas oficiales (`LIVE_SOURCES[id].officialUrl`)

Todas respondieron 200 el 2026-11-10. Varias son aplicaciones de una sola página que responden 200 a cualquier ruta. IMSA tiene protección anti-bots y abre bien en el navegador.

| Categoría | Enlace | Nota |
|---|---|---|
| F1 | formula1.com/en/timing/f1-live | Requiere F1 TV o la app |
| F2 / F3 / F1 Academy | fiaformula2.com, fiaformula3.com, f1academy.com `/livetiming/index.html` | |
| Porsche Supercup | racing.porsche.com/mobil-1-supercup/live-timing | |
| MotoGP / Moto2 / Moto3 | timingpass.motogp.com/en/ | Pago |
| IndyCar / Indy NXT | indycar.com/leaderboard, indynxt.com/leaderboard | |
| NASCAR (las 3) | nascar.com/leaderboard | |
| GTWC Europa, Asia, América, Australia e IGTC | `{sitio}/watch-live#live-timing` | Sólo en fines de semana de carrera |
| DTM | dtm.com/en/livetiming | |
| NLS | nuerburgring-langstrecken-serie.de/live/ | |
| IMSA | imsa.com/leaderboard | |
| WEC / ELMS | plus.fiawec.com | Puede pedir cuenta |
| 24H Series | livetiming.getraceresults.com/24hseries | |
| GT Open | gtopen.gtsport.es/resultados | Sin vivo público |
| TC, TC Pista, TC Pick Up, TC Mouras | tiempos.actc.org.ar/live/{tc,tcp,tcpk,tcm} | |
| TN | apat.org.ar/carreras | Sin vivo |
| TC2000 | speedhive.mylaps.com/livetiming/YLNSNDLQ-2147484293 | Enlace "Tiempos Online" del sitio oficial |
| Turismo Pista | aptpweb.com.ar/resultados-clase-1/ | Sin vivo |

## Limitaciones

- **Fixtures:** las de NASCAR y MotoGP son de sesiones **terminadas**, porque hoy no había nada en pista. Los estados "en vivo" se prueban modificando esas fixtures reales. Conviene capturar un feed durante una sesión real y sumarlo a `shared/test/fixtures/live/`.
- **Códigos sin observar:** en NASCAR no se vieron `flag_state` 3 y 5 ni `status` 2. En MotoGP no se vieron los `status_name` distintos de CL y RT.
- **Speedhive:** muestra resultados de la sesión terminada, no vivo. Si el cronometrador cambia de cuenta en Speedhive o renombra eventos o grupos, hay que actualizar `LIVE_SOURCES`.
