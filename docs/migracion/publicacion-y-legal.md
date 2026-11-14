# Publicación, web propia y aspectos legales

Volver al [README](README.md). Requisitos y precios consultados el **2026-11-14** (fuentes al final).

> Esto no es asesoramiento legal. Es un mapa de riesgos para decidir con información; si la app va a ser pública y
> sobre todo si va a tener ingresos, conviene una consulta con un abogado de propiedad intelectual y datos
> personales.

## 1. Uso propio vs. app pública: qué cambia

| Tema | Uso propio (vos y conocidos) | App pública en Play Store |
|---|---|---|
| Distribución | APK directo, prueba interna de Play (hasta 100 testers, sin revisión de contenido) o TWA | Producción en Play Store |
| Cuenta de Play | Opcional (USD 25 una vez) | Obligatoria |
| Instalar APK fuera de Play | Hoy libre. Desde 2027 Google exige desarrollador verificado en teléfonos certificados (en Brasil, Indonesia, Singapur y Tailandia desde el 30/9/2026). Para hasta **20 dispositivos** hay cuenta de "distribución limitada" sin documento ni arancel. | No aplica |
| Política de privacidad | Recomendable | **Obligatoria** (la pide el formulario de seguridad de datos) |
| Formulario de seguridad de datos | Solo si pasa a prueba cerrada/abierta/producción (la prueba interna está exenta) | Obligatorio |
| Prueba cerrada 12 × 14 | No | **Sí**, si la cuenta es personal y fue creada después del 13/11/2023 |
| Logos, fotos oficiales, proxy en vivo | Riesgo bajo (no hay distribución pública) | Hay que resolverlos (sección 4) |
| Open-Meteo | Gratis (no comercial) | Gratis solo si no hay publicidad ni suscripciones |
| Hosting de datos | GitHub Pages sirve | Salir de Pages (no admite un "negocio en línea"); R2/Cloudflare |
| Borrado de cuenta | No aplica | Obligatorio si hay cuentas (en la app **y** por web) |

## 2. Google Play Store

### 2.1 Cuenta de desarrollador

- **Arancel único de USD 25** (tarjeta de crédito/débito, no prepaga).
- Verificación de identidad con documento y tarjeta **a tu nombre legal**; elegir tipo de cuenta: **personal** u
  **organización** (organización pide más datos de la empresa, como el número D-U-N-S).
- Cuentas personales: además hay que **verificar acceso a un dispositivo Android** con la app Play Console y cumplir
  el **requisito de prueba**: una prueba cerrada con **al menos 12 testers** que se mantengan suscriptos **durante
  14 días seguidos** antes de poder pedir acceso a producción. Conseguir 12 personas con Android (amigos, familia,
  grupos de fierreros) es la parte lenta: arrancarla apenas haya una versión usable.
- Play muestra públicamente el nombre del desarrollador y un email de contacto. Usar un email del dominio de la
  app (Cloudflare Email Routing, gratis, reenvía a tu casilla personal). Si en algún momento monetizás, Google puede
  pedir y mostrar más datos (estado de "comerciante" para la UE): revisarlo antes de activar ingresos.

### 2.2 Requisitos técnicos

| Requisito | Detalle | Con Expo |
|---|---|---|
| Formato | **Android App Bundle (`.aab`)** para apps nuevas | `eas build -p android --profile production` genera AAB |
| API objetivo | Desde el **31/8/2026**: apps nuevas y actualizaciones con **Android 16 (API 36)** o superior (prórroga hasta el 1/11/2026 a pedido) | El SDK 58 de Expo ya apunta a una API reciente; confirmar `targetSdkVersion` en el build (con `expo-build-properties` si hiciera falta) |
| Firma | **Play App Signing**: Google guarda la clave de firma de la app; vos (o EAS) guardás la *upload key* | EAS genera y guarda la *upload key*. Hacer copia (`eas credentials`) |
| Versionado | `versionCode` entero que siempre sube; `versionName` legible (`1.0.0`) | `eas.json` con `"appVersionSource": "remote"` y `"autoIncrement": true` |
| Permisos | Solo los necesarios: `POST_NOTIFICATIONS` (Android 13+), `INTERNET`; calendario (`READ/WRITE_CALENDAR`) solo si se usa `expo-calendar` | Expo los declara por cada módulo; revisar el `AndroidManifest` final y quitar los que sobren (`android.blockedPermissions`) |
| Primer envío | La primera subida a Play Console se hace **a mano** (Google lo exige); después, automático | `eas submit -p android` con una cuenta de servicio de Google Cloud (JSON) |

### 2.3 Ficha de la tienda

- Ícono 512 × 512 PNG, gráfico destacado 1024 × 500, al menos 2 capturas de teléfono (mejor 4–8: Agenda, Evento,
  Categoría con tabla, Piloto, Circuito con trazado, En vivo).
- Descripción corta (80 caracteres) y completa (4.000). Mencionar "fuentes oficiales" y la aclaración de que la app
  no está afiliada a ninguna categoría (sección 4.6).
- Categoría: **Deportes**. Público objetivo: adultos/general (no "diseñada para niños", que suma requisitos).
- Cuestionario de clasificación de contenido (IARC): sin violencia ni compras → clasificación para todo público.
- Declaraciones: anuncios (sí/no), acceso a la app (si hay login obligatorio, credenciales de prueba para la revisión;
  con cuentas opcionales no hace falta), ¿es una app de noticias? (**no**: es una agenda; las notas son enlaces a
  terceros. Si contestás que sí, se aplican requisitos extra de la política de noticias).

### 2.4 Formulario de seguridad de datos

Todas las apps publicadas (incluso las de prueba cerrada/abierta) lo completan, **aunque no recojan datos**, y tienen
que enlazar una política de privacidad. "Recolectar" = enviar datos fuera del dispositivo (también lo que mandan las
librerías de terceros). Para esta app:

| Dato | Fase 1 (sin cuentas) | Con avisos (fase 2) | Con cuentas (fase 3) |
|---|---|---|---|
| Identificadores de dispositivo | No | **Sí**: token de push (Expo/FCM). Finalidad: funcionalidad de la app. No se comparte. | Sí |
| Preferencias (categorías seguidas, anticipación, zona horaria) | No (quedan en el teléfono) | **Sí**, asociadas al token | Sí, asociadas a la cuenta |
| Email / nombre | No | No | **Sí** (inicio de sesión) |
| Ubicación | **No** (el clima se pide con las coordenadas del circuito, no del usuario) | No | No |
| Registros de errores | Solo si se suma Sentry | Ídem | Ídem |
| Cifrado en tránsito | Sí (HTTPS) | Sí | Sí |
| Borrado | — | "Desactivar avisos" borra el dispositivo | Borrado de cuenta en la app y por web |

### 2.5 Borrado de cuenta (si hay cuentas)

- Opción **dentro de la app** para borrar la cuenta y sus datos.
- **Enlace web** donde pedir el borrado sin tener que abrir la app (p. ej. `https://<dominio>/borrar-cuenta`), que
  nombre la app o el desarrollador tal como figura en Play. Se carga en Play Console.
- La política de privacidad dice qué se conserva y por cuánto (p. ej. registros de envío de avisos 7 días).

### 2.6 EAS (Expo Application Services)

| Plan | Precio | Incluye |
|---|---|---|
| Free | USD 0 | 15 builds de Android y 15 de iOS, cola de baja prioridad, tope de 45 minutos por build; EAS Update para 1.000 usuarios activos por mes; EAS Submit |
| Starter | USD 19/mes + uso | USD 45 de crédito de builds, cola prioritaria, builds de hasta 2 h, Update para 3.000 usuarios activos |

Para este proyecto alcanza el plan gratis: se hacen pocos builds nativos y los cambios de JavaScript van por EAS
Update. Si la cola de baja prioridad molesta, build local con Android Studio.

### 2.7 iPhone (más adelante)

Mismo código. Requiere Apple Developer Program (USD 99/año), una Mac o EAS Build para iOS, y revisión de Apple
(más estricta con apps que "solo muestran contenido web" y con marcas de terceros).

## 3. Dominio y web propia

| Pieza | Recomendación | Costo |
|---|---|---|
| Dominio | `.com` en **Cloudflare Registrar** (precio de costo, sin recargo en la renovación) o `.com.ar` en NIC Argentina (arancel en pesos, verificar el vigente en nic.ar) | ~USD 10–15/año (`.com`) |
| DNS y SSL | Cloudflare (DNS gratis, certificados automáticos) | USD 0 |
| Web (`<dominio>`) | Export estático de Expo (`web.output: "static"`) en **Cloudflare Pages** o Workers Static Assets. Pages gratis: 500 builds/mes, hasta 20.000 archivos de hasta 25 MiB por sitio | USD 0 |
| Datos (`data.<dominio>`) | Fase 1: GitHub Pages con dominio propio. Pública: **R2** con dominio propio (gratis: 10 GB-mes, 1 M de operaciones de escritura y 10 M de lectura por mes, **egreso sin costo**) | USD 0 |
| API (`api.<dominio>`) | El Worker actual con ruta personalizada | USD 0 (o USD 5/mes si hace falta Workers Paid) |
| Email de contacto | Cloudflare Email Routing (`contacto@<dominio>` → tu casilla) | USD 0 |
| App Links / TWA | `https://<dominio>/.well-known/assetlinks.json` con la huella SHA-256 de la clave de firma de Play | — |

Por qué el dominio propio es lo primero: la app instalada guarda URLs. Si apuntan a `*.github.io` o a
`*.workers.dev`, cambiar de proveedor obliga a publicar una versión nueva y esperar que todos actualicen. Con
`data.<dominio>` y `api.<dominio>` el origen se cambia en el DNS. Además, **App Links y la TWA necesitan
`assetlinks.json` en la raíz del dominio**, cosa que un sitio de proyecto de GitHub Pages (`/agenda-deporte-motor/`)
no puede servir.

### TWA (alternativa barata)

Empaquetar la PWA actual con Bubblewrap o PWABuilder genera un AAB que abre la web a pantalla completa en Chrome.
Requiere dominio propio con `assetlinks.json`. Ventajas: una semana de trabajo, sin reescribir nada, avisos web
funcionando (Chrome los delega a la app). Desventajas: sin calendario nativo, sin widgets, depende de Chrome, y Play
puede rechazar apps que sean "solo un sitio web" si no aportan funcionalidad (una agenda instalable con avisos
suele pasar). **Capacitor** es el punto intermedio (PWA dentro de un WebView con plugins nativos), pero Web Push no
funciona en el WebView: hay que usar su plugin de push con FCM.

## 4. Riesgos legales de una app pública

<a id="fuentes-de-datos"></a>

### 4.1 Horarios, resultados y tablas

- Los datos en sí (horarios, posiciones, puntos) son hechos y en general no tienen derecho de autor. Pero: (a) en la
  UE existe un derecho *sui generis* sobre bases de datos que protege la extracción sistemática de una parte
  sustancial; (b) los términos de uso de los sitios oficiales (formula1.com, motogp.com, etc.) suelen prohibir el uso
  comercial y la extracción automatizada; (c) algunas categorías licencian sus datos a proveedores pagos.
- **Mitigación:** mantener lo que ya hace la app (cada dato con su fuente y enlace, sin copiar textos ni diseño),
  frecuencia de lectura moderada con `User-Agent` identificable (ya existe), respetar `robots.txt`, no reproducir
  tablas completas de fuentes que lo prohíban expresamente, y tener un canal de contacto para pedidos de baja.
- **Uso comercial = riesgo mayor.** Antes de monetizar, leer los términos de cada fuente principal (F1/FOM, Dorna,
  NASCAR, ACO/WEC, WRC Promoter, ASO/Dakar, ACTC, etc.).

### 4.2 Tiempos en vivo

- MotoGP vende su cronometraje en vivo (TimingPass). Mostrarlo gratis en una app pública, leyendo una API no
  documentada, compite con un producto pago: **no hacerlo en la app pública** (dejar solo el enlace oficial).
- NASCAR publica su feed con CORS abierto (lo usa su propio sitio); igual son datos de su propiedad: riesgo medio.
- Speedhive: la API de resultados es pública, la de tiempo real pide clave (ya descartada). Revisar sus términos.
- Pedir esas APIs **desde cada teléfono** (posible en nativo) multiplica los pedidos: para una app pública, siempre
  por el proxy con caché.

### 4.3 Fotos e imágenes

| Origen | Condición | Qué hacer |
|---|---|---|
| Wikimedia Commons (`CircuitImage`, `CreditedImage`) | Cada archivo tiene su licencia (CC BY, CC BY-SA, dominio público…). Hay que mostrar autor, licencia con enlace y enlace al archivo | Ya se guarda `credit`, `license` y `page`: mostrarlos siempre junto a la imagen |
| Sitios oficiales (fotos de pilotos de la tanda 5: `license: "© titular"`) | Derecho de autor del titular; enlazarlas no es lo mismo que tener permiso para mostrarlas | **En la app pública, no mostrarlas** (o pedir permiso). Usar solo Commons o iniciales (`DriverAvatar`) |
| Logos de equipos y categorías (aunque estén en Commons como "PD-textlogo") | Pueden ser libres de derecho de autor pero siguen siendo **marcas** | No usarlos como ícono ni en lugares que sugieran afiliación; la app ya usa siglas propias (`SeriesCrest`) |
| `og:image` de noticias | Imagen con derechos del medio, mostrada desde su servidor | Riesgo bajo-medio (los medios publican `og:image` para que se muestre al compartir). Para la app pública: miniatura chica + enlace, o solo título y fuente |
| Mapas oficiales de etapas (rally) | Derechos del organizador | Enlazar en lugar de mostrar, o mostrar con crédito y aceptar el riesgo |

### 4.4 Textos y datos abiertos

- **Wikipedia** (extractos de circuitos, bios): CC BY-SA 4.0. Atribuir con enlace al artículo y a la licencia; si se
  modifica el texto, el resultado queda bajo la misma licencia.
- **Wikidata**: CC0, sin condiciones.
- **OpenStreetMap** (trazados): ODbL. Atribución "© Colaboradores de OpenStreetMap" con enlace a
  `openstreetmap.org/copyright` (ya está en `TrackOutline`). Los trazados son una base de datos derivada: si se
  publican, se publican bajo ODbL (ya se hace: `license: "ODbL"`).

<a id="open-meteo"></a>

### 4.5 Open-Meteo

- La API gratuita es **solo para uso no comercial**: sitios o apps privados o sin fines de lucro **sin suscripciones
  ni publicidad**. Las donaciones voluntarias están permitidas.
- Límites del plan gratis: menos de 10.000 llamadas por día, 5.000 por hora y 600 por minuto (por IP), y 300.000 por
  mes. Como cada teléfono pide con su propia IP, no es un problema de cupo sino de licencia.
- Datos bajo CC BY 4.0: atribución obligatoria (ya está: `WEATHER_SOURCE`).
- Si hay publicidad o suscripción: plan comercial de Open-Meteo (Standard: 1 M de llamadas por mes; el precio no
  figura en la página, se ve al contratar) o un proveedor con uso comercial gratuito (p. ej. MET Norway, que pide
  `User-Agent` identificable y atribución; verificar sus términos), idealmente con el Worker como caché por circuito.

<a id="marcas"></a>

### 4.6 Marcas

- "F1", "FORMULA 1", "GRAND PRIX" (en ciertos usos), "MotoGP", "NASCAR", "WRC", "Dakar", "IndyCar", "TC2000",
  etc. son marcas registradas. La política de propiedad intelectual de Play prohíbe usar marcas ajenas de manera
  que confunda sobre quién hace la app.
- **Permitido en la práctica:** nombrar las categorías en el contenido (uso nominativo: "horarios de la F1").
- **Evitar:** marcas en el **nombre de la app**, el **ícono**, el nombre del paquete (`com.<algo>.f1agenda`), el
  gráfico destacado o las capturas de forma protagónica; colores y tipografías que imiten identidades oficiales.
- Agregar en la ficha y en "Acerca de": *"App no oficial. No está afiliada ni respaldada por ninguna de las
  categorías, equipos u organizadores mencionados. Las marcas pertenecen a sus titulares."*

### 4.7 Datos personales

- Sin cuentas ni avisos, la app no recoge datos personales: la política de privacidad lo dice y listo.
- Con avisos: el token de push y las preferencias son datos vinculados a un dispositivo. Con cuentas: email.
- Argentina: Ley 25.326 de Protección de Datos Personales (consentimiento, finalidad, derechos de acceso,
  rectificación y supresión; inscripción de la base ante la AAIP). Si hay usuarios en la UE, GDPR. Una política de
  privacidad simple y honesta + borrado fácil cubre lo esencial; la inscripción ante la AAIP conviene confirmarla con
  un profesional.
- Contenido mínimo de la política: quién sos y contacto; qué datos (token, preferencias, email), para qué (avisos,
  sincronizar), dónde se guardan (Cloudflare, Supabase; países), por cuánto tiempo, con quién se comparten (Expo y
  Google para entregar los avisos), cómo borrar, que no hay publicidad ni venta de datos, que el clima se pide con
  coordenadas del circuito y no del usuario.

### 4.8 Términos de la propia app

Página `/terminos` corta: la información es orientativa, puede tener errores u horarios desactualizados, verificar en
la fuente oficial (la app ya enlaza la fuente de cada dato), sin garantía.

## 5. Checklist de publicación

- [ ] Dominio propio con `data.`, `api.` y la web; email de contacto.
- [ ] Política de privacidad, términos y página de borrado (si hay cuentas) publicadas en el dominio.
- [ ] Nombre, ícono y capturas sin marcas ajenas; aviso de "app no oficial".
- [ ] Fotos de sitios oficiales y logos fuera de la versión pública; atribuciones de Commons, Wikipedia y OSM
      visibles.
- [ ] Tiempos en vivo de MotoGP fuera; resto por proxy con caché.
- [ ] Open-Meteo: sin publicidad ni suscripción, o plan comercial / otro proveedor.
- [ ] Cuenta de Play verificada; prueba cerrada con 12 testers × 14 días cumplida.
- [ ] Formulario de seguridad de datos, clasificación de contenido, público objetivo, declaración de anuncios.
- [ ] AAB firmado (API objetivo 36+), primera subida manual, `eas submit` configurado.
- [ ] `assetlinks.json` publicado (App Links).

## Fuentes (consultadas el 2026-11-14)

- Registro y arancel de la cuenta de Play: <https://support.google.com/googleplay/android-developer/answer/6112435>
- Requisito de prueba para cuentas personales nuevas: <https://support.google.com/googleplay/android-developer/answer/14151465>
- API objetivo: <https://developer.android.com/google/play/requirements/target-sdk>
- Formulario de seguridad de datos: <https://support.google.com/googleplay/android-developer/answer/10787469>
- Borrado de cuenta: <https://support.google.com/googleplay/android-developer/answer/13327111>
- Propiedad intelectual (Play): <https://support.google.com/googleplay/android-developer/answer/9888072>
- Verificación de desarrolladores Android (instalación fuera de Play): <https://developer.android.com/developer-verification>
- EAS, precios: <https://expo.dev/pricing>
- Expo SDK 58: <https://expo.dev/changelog/sdk-58>
- Open-Meteo, términos: <https://open-meteo.com/en/terms> y precios: <https://open-meteo.com/en/pricing>
- GitHub Pages, límites y uso permitido: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
- GitHub Actions, facturación: <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- Cloudflare Pages, límites: <https://developers.cloudflare.com/pages/platform/limits/>
- Cloudflare R2, precios: <https://developers.cloudflare.com/r2/pricing/>
