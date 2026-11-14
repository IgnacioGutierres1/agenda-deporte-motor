# Cuentas de usuario y monetización

Volver al [README](README.md). Documentación consultada el **2026-11-14** (fuentes al final). Solo planificación:
nada de esto está implementado.

## Decisiones tomadas (2026-11-14)

| Pregunta | Respuesta | Consecuencia para el plan |
|---|---|---|
| ¿Uso propio o app pública? | **Uso propio por ahora.** | Fases 0 a 3 sin trámites de Play producción ni revisión legal. Todo se diseña "listo para ser público". |
| ¿Cuentas de usuario? | **Sí**: registro con email y con Google, más otro método recomendado. | Fase 3 con Supabase Auth (ver sección 1). La base de datos deja de ser opcional: se hace. |
| ¿Monetización? | **En el futuro: publicidad y suscripción.** | Nueva **fase 5** después de publicar (ver sección 2). No se integra nada mientras sea de uso propio, pero desde la fase 1 se dejan los "enchufes" (sección 3). |

## 1. Cuentas

### 1.1 Métodos de inicio de sesión

| Método | Recomendación | Por qué |
|---|---|---|
| **Google** | **Sí, desde el día uno.** Es el principal en Android. | En Android usa el selector nativo (Credential Manager): un toque, sin contraseña, sin abrir el navegador. Supabase lo recibe con `signInWithIdToken`. En la web, botón de Google (OAuth o One Tap). |
| **Email con código de 6 dígitos** | **Sí, desde el día uno.** En vez de contraseña y en vez de enlace mágico. | Sin contraseñas no hay que guardarlas, ni resetearlas, ni sufrir filtraciones. El código anda mejor que el enlace mágico en el teléfono: el enlace se abre en el navegador de la app de mail y no vuelve bien a la app. En Supabase es el mismo flujo que el enlace mágico cambiando la plantilla del mail a `{{ .Token }}`. |
| **Llaves de acceso (passkeys)** | **Sí, como tercer método, cuando esté estable.** Es mi recomendación para "otro tipo de login". | Huella o bloqueo de pantalla, sin contraseña ni mail, resistente al phishing. En Android aparece en la misma hoja que Google (Credential Manager). Hoy en Supabase está en **beta** (`signInWithPasskey` en la web); para la app nativa falta una integración madura en React Native. Sumarlo cuando Supabase lo marque estable. |
| **Anónimo** (sin pedir nada) | **Sí, como base**, invisible para el usuario. | Cada instalación tiene un usuario desde el primer uso: se puede seguir pilotos, configurar avisos y hasta suscribirse sin registrarse. Al "crear cuenta" se vincula Google o el email **al mismo usuario** y no se pierde nada. |
| Apple | Solo si algún día hay versión para iPhone. | En iPhone, si ofrecés Google, Apple exige ofrecer también una opción equivalente (Sign in with Apple la cumple). En Android no hace falta. |
| Contraseña | No. | Más soporte (olvidos, resets) y más riesgo, sin ventaja frente al código por email. |
| SMS / teléfono | No. | Cada SMS se paga y es blanco de fraude (bombeo de SMS a números premium). |
| Facebook, X, Discord, GitHub | No. | Poco valor para este público; Facebook pide revisión de la app. Se pueden sumar después sin rehacer nada. |

**Vinculación de identidades:** si alguien entra con Google y otro día con el código al mismo email, Supabase une
las dos identidades en un solo usuario (lo hace solo cuando el email está verificado). Para pasar de anónimo a
cuenta se usa `linkIdentity` (Google, con el token nativo) o `updateUser({ email })` + código; requiere activar
*Manual linking* en el proyecto.

### 1.2 Experiencia propuesta

1. Primer uso: la app anda completa, sin pantalla de registro (usuario anónimo por detrás).
2. En Ajustes y en momentos naturales ("seguí a Colapinto en todos tus dispositivos", "no pierdas tus avisos si
   cambiás de teléfono"): **"Crear cuenta o iniciar sesión"** → hoja con "Continuar con Google" y "Continuar con
   email". (Más adelante: "Usar llave de acceso".)
3. Con cuenta: lo seguido, los avisos y la suscripción se sincronizan entre el teléfono y la web.
4. Ajustes → Cuenta: email, métodos vinculados, **cerrar sesión** y **borrar cuenta** (obligatorio en Play Store,
   también desde una página web).

Las cuentas siguen siendo **opcionales**: la agenda, los resultados y el historial nunca piden registrarse.

### 1.3 Configuración de Supabase Auth (checklist de la fase 3)

- [ ] Proveedores: **Anonymous**, **Email** (OTP de 6 dígitos: plantilla con `{{ .Token }}`), **Google**.
- [ ] *Manual linking* activado (para pasar de anónimo a cuenta).
- [ ] **SMTP propio** con el dominio (Resend, Brevo, Amazon SES u otro con plan gratis): el servicio de mail que trae
      Supabase permite **2 mails por hora** y es solo para pruebas. Configurar SPF, DKIM y DMARC del dominio para que
      el código no caiga en spam.
- [ ] CAPTCHA (Cloudflare Turnstile) para los usuarios anónimos y los pedidos de código: evita que un bot cree
      miles de usuarios o mande mails.
- [ ] Google Cloud: un cliente OAuth **Web** (su ID va como `webClientId` en la app y en Supabase) y uno **Android**
      con el nombre del paquete y la huella SHA-1 de **cada** certificado: el de desarrollo (EAS), el de subida y
      el de *Play App Signing*. El error típico (`DEVELOPER_ERROR`) es una SHA-1 que falta.
- [ ] Pantalla de consentimiento de Google con nombre, logo, dominio y enlace a la política de privacidad.
- [ ] Librería en la app: `@react-native-google-signin/google-signin` (requiere *development build*, no anda en
      Expo Go).
- [ ] Sesión guardada en el teléfono con almacenamiento seguro (`expo-secure-store`) y renovación automática del
      token.

### 1.4 Borrado de cuenta

- En la app y por web (página `<dominio>/borrar-cuenta`), como pide Play Store.
- Borra `auth.users` → en cascada todo lo del usuario (ver [base-de-datos.md](base-de-datos.md#44-usuarios-fase-3)).
- Si tenía suscripción: **borrar la cuenta no cancela el cobro de Play**. La pantalla de borrado tiene que avisarlo
  y llevar a "Administrar suscripción" en Play. También se borra el cliente en RevenueCat (su API lo permite).

## 2. Monetización (fase 5, después de publicar)

### 2.1 Modelo recomendado: gratis con publicidad + "Pro" sin publicidad

| | Gratis | Pro (suscripción) |
|---|---|---|
| Agenda, horarios, resultados, historial, noticias, mapas, clima | Sí | Sí |
| Seguir pilotos, equipos y categorías; avisos básicos | Sí | Sí |
| Cuenta y sincronización | Sí | Sí |
| Publicidad | Banner discreto | **Sin publicidad** |
| Avisos avanzados (por piloto o equipo, "terminó la carrera" con el podio, cambios de horario, no molestar) | — | Sí |
| Calendario personal `.ics` con lo que seguís | — | Sí |
| Widget de Android "próxima sesión" (cuando exista) | — | Sí |
| Temas y personalización | — | Sí |

**Regla de oro: lo que se cobra son funciones propias de la app, nunca los datos de terceros.** Horarios,
resultados y tiempos son de la FIA, F1, MotoGP, ACTC, etc.: ponerlos detrás de un pago sube mucho el riesgo
legal (ver [publicacion-y-legal.md, sección 4](publicacion-y-legal.md#4-riesgos-legales-de-una-app-pública)). Por la
misma razón conviene que la sincronización siga siendo gratis: es lo que hace que la gente cree cuenta.

**Precio de partida sugerido:** alrededor de USD 1,5 por mes o USD 10 por año, con precios locales en pesos que
Play calcula solo y 7 días de prueba gratis. Es un punto de partida para ajustar, no un estudio de mercado.

**Expectativa realista:** con pocos cientos de usuarios, la publicidad deja pocos dólares por mes. Su rol principal es
empujar a Pro; la suscripción es la que puede cubrir los costos (Supabase Pro, Open-Meteo comercial, dominio).

### 2.2 Suscripciones

| Tema | Recomendación |
|---|---|
| Cobro en Android | **Google Play Billing**, obligatorio para funciones digitales dentro de la app. Google se queda con el **15 %** de las suscripciones. |
| Librería | **RevenueCat** (`react-native-purchases`, con *development build*): resuelve la validación de compras, renovaciones, reintentos de cobro y periodos de prueba sin servidor propio. **Gratis mientras la facturación mensual sea menor a USD 2.500**; después cobra un porcentaje chico. |
| Identidad | El `app_user_id` de RevenueCat es el **id de Supabase** del usuario (sirve también el anónimo). Así la compra queda atada a la cuenta y se ve en la web. |
| Estado "Pro" en el servidor | Webhook de RevenueCat → Worker de Cloudflare → tabla `entitlements` en Supabase (ver [base-de-datos.md](base-de-datos.md#44-usuarios-fase-3)). El Worker usa ese dato para los avisos avanzados y el `.ics` personal. |
| Web | Al principio **Pro se compra solo en Android**; en la web se ve como Pro quien ya lo tiene en su cuenta. Cobrar en la web desde Argentina tiene un problema: **Stripe no abre cuentas para empresas radicadas en Argentina** (verificarlo al momento). Alternativas: Mercado Pago (tiene suscripciones), o un *merchant of record* como Paddle o Lemon Squeezy, que cobran por vos y te liquidan. Se integra después por webhook a la misma tabla `entitlements`. |
| Pruebas | La compra solo se puede probar con la app en una pista de prueba de Play (la prueba interna alcanza) y "testers de licencias" configurados en Play Console: no se cobra de verdad. |
| Cuenta de comerciante | Perfil de pagos en Play Console con cuenta bancaria argentina. Impuestos: es exportación de servicios (monotributo o responsable inscripto, facturación tipo E). **Consultar con un contador antes de cobrar el primer peso.** |

### 2.3 Publicidad

| Tema | Recomendación |
|---|---|
| Red | **Google AdMob** con `react-native-google-mobile-ads` (requiere *development build*; no anda en Expo Go). |
| Consentimiento | Formulario de **UMP** (Google) antes de pedir anuncios: obligatorio para usuarios de la UE, el Reino Unido y Suiza, y ordena el resto. Sin consentimiento, anuncios no personalizados. |
| Formatos | Banner adaptativo al pie de listas (agenda, resultados, noticias) y, como mucho, un nativo cada N noticias. **Sin pantallas completas (intersticiales)** ni anuncios en vivo, en avisos o en widgets (Play prohíbe anuncios en notificaciones). |
| Declaraciones en Play | "La app contiene anuncios" en la ficha; formulario de seguridad de datos con **ID de publicidad** y datos de uso compartidos con Google para publicidad; permiso `AD_ID`. Público objetivo **mayores de 13** (mejor 18+) para no entrar en la política de Familias. |
| `app-ads.txt` | Publicado en la raíz del dominio propio (AdMob lo verifica). |
| Web | AdSense pide sitio aprobado y "contenido original"; una agenda armada con datos de terceros puede ser rechazada. Recomendado: **sin anuncios en la web** al principio. |
| Pro | Con la suscripción activa no se inicializa el SDK de anuncios (ni siquiera se pide consentimiento). |

### 2.4 Requisitos antes de monetizar (bloqueantes)

1. **App pública ya publicada** (fase 4) con la revisión legal hecha: fotos de sitios oficiales y logos fuera,
   tiempos en vivo resueltos, aviso de "app no oficial".
2. **Open-Meteo comercial**: con publicidad o suscripción el plan gratis deja de valer (ver
   [publicacion-y-legal.md, 4.5](publicacion-y-legal.md#45-open-meteo)). Plan pago u otro proveedor del clima.
3. **Datos fuera de GitHub Pages** (R2 o Workers Static Assets con el dominio): sus términos no permiten uso comercial.
4. **Supabase Pro** (USD 25/mes): sin pausas, con copias de seguridad diarias. Con plata de por medio no se puede
   perder la tabla de suscripciones.
5. Política de privacidad actualizada (anuncios, ID de publicidad, compras) y términos con condiciones de la
   suscripción (renovación, cancelación, reembolsos según Play).
6. Contador consultado (sección 2.2).

## 3. Qué dejar preparado desde la fase 1 (sin integrar nada)

Mientras sea de uso propio no se integran anuncios ni pagos, pero estas decisiones de diseño evitan rehacer
pantallas después:

- **Un solo punto que diga si el usuario es Pro** (por ejemplo un hook `useEntitlements()` que hoy devuelve
  siempre "gratis"). Ninguna pantalla pregunta por RevenueCat directamente.
- **Lugares reservados para anuncios**: el componente de lista acepta un "espacio de anuncio" opcional que hoy no
  renderiza nada. Así sumar AdMob no cambia los diseños.
- **Funciones Pro detrás de una bandera** (`features.ts`): avisos avanzados, `.ics` personal, temas. Hoy todas
  activas para vos.
- **Ajustes → Cuenta** pensada desde el principio (aunque en la fase 1 solo diga "Próximamente").
- **El id de usuario como clave de todo**: preferencias, seguidos y dispositivos se guardan pensando en que
  algún día cuelgan de `auth.uid()`.

## 4. Cambios en el plan por fases

| Fase | Cambio |
|---|---|
| 1 | Suma lo de la sección 3 (enchufes vacíos). |
| 3 | Deja de ser opcional. Auth con anónimo + Google + email con código; SMTP propio; CAPTCHA. Passkeys cuando estén estables. |
| 4 | Publicar sin anuncios ni pagos todavía; la app pública de uso gratuito es la base para monetizar. |
| **5 (nueva)** | Monetización: RevenueCat + Play Billing, AdMob + UMP, tabla `entitlements` y webhook, Open-Meteo comercial, Supabase Pro, contador. Ver [plan-por-fases.md](plan-por-fases.md#fase-5-monetización). |

## Fuentes (consultadas el 2026-11-14)

- Supabase, inicio de sesión nativo con Google (Expo): <https://supabase.com/docs/guides/auth/social-sign-in/auth-google>
- Supabase, email sin contraseña (OTP y enlace mágico): <https://supabase.com/docs/guides/auth/auth-email-passwordless>
- Supabase, SMTP propio y límite del servicio incluido: <https://supabase.com/docs/guides/auth/auth-smtp>
- Supabase, usuarios anónimos: <https://supabase.com/docs/guides/auth/auth-anonymous>
- Supabase, vinculación de identidades: <https://supabase.com/docs/guides/auth/auth-identity-linking>
- Supabase, passkeys (beta): <https://supabase.com/docs/reference/javascript/auth>
- RevenueCat con Expo: <https://www.revenuecat.com/docs/getting-started/installation/expo>
- RevenueCat, precios: <https://www.revenuecat.com/pricing>
- RevenueCat, webhooks: <https://www.revenuecat.com/docs/integrations/webhooks>
- `react-native-google-mobile-ads` (AdMob, plugin de Expo y consentimiento): <https://docs.page/invertase/react-native-google-mobile-ads>
- Comisión de Google Play: <https://support.google.com/googleplay/android-developer/answer/112622>
- Política de pagos de Google Play: <https://support.google.com/googleplay/android-developer/answer/9858738>
- Política de anuncios de Google Play: <https://support.google.com/googleplay/android-developer/answer/9857753>
