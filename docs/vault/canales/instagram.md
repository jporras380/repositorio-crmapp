---
estado: vivo
fecha: 2026-09-07
modulo: canales
tags: [canal, instagram, messenger, meta, fase-2]
---

# Canal — Instagram / Messenger (Graph API)

Fase 2. Criterio de salida: dos canales en una sola bandeja.

## Restricciones que condicionan el diseño

- **DMs y comentarios llegan por el mismo webhook pero son cosas distintas.** El comentario es público y cuelga de una publicación; el DM es privado y cuelga de una conversación. Por eso `conversations.kind` distingue `dm` de `comment_thread` desde el esquema inicial: meterlos en la misma tabla sin distinguir obliga a reescribirla en fase 2.
- **Respuesta privada a un comentario: una sola por comentario, y con ventana.** No es una conversación normal que se pueda retomar. Si el agente gasta la respuesta privada en un saludo, ya no hay segunda oportunidad — el producto debe hacer esto visible antes de enviar, no después.
- **Dos acciones distintas sobre un comentario:** responder públicamente (hilo del comentario) y responder en privado (abre DM). Son botones separados con consecuencias separadas.
- **Instagram exige URL pública para los medios salientes**, al contrario que WhatsApp, que acepta subida directa. Nuestro almacenamiento tiene que poder exponer una URL firmada accesible desde fuera. Esto condiciona la configuración de S3/R2: no todo puede ser privado.
- **Ventana de mensajería** propia, distinta de la de WhatsApp en duración y en reglas. `session_expires_at` guarda el instante, no las horas: la política de cuánto dura vive en el adaptador del canal.

## Identidad

El usuario de Instagram llega con un identificador *scoped* a nuestra app. **No es el `@handle` público y no sirve para cruzarlo con nada externo.** Es exactamente el motivo por el que `contact_identities` existe separada de `contacts`: la identidad del canal es un hecho del proveedor, la persona es interpretación nuestra. Ver P-08.

## Implementación (PR-19, 2026-09-09)

`AdaptadorInstagram` e `IngestaInstagram` en `packages/channels/src/instagram/`, **sin tocar `ChannelAdapter` ni `core`** (criterio de salida de fase 2 en lo que toca al núcleo).

- Envío: `POST /{ig-user-id}/messages` con `recipient.id`; medios solo por URL (`attachment.payload.url`), el pie va como segundo mensaje; **buffer rechazado** antes de llamar a Meta. Respuesta privada a comentario: `recipient.comment_id`; pública: `POST /{comment-id}/replies`. Plantillas: `tipo_no_soportado`; `syncTemplates` devuelve `[]`.
- Capacidades: text/image/video/audio; 1000 caracteres; imagen 8 MB, vídeo y audio 25 MB; `respuestasPrivadasPorComentario: 1`; ventana 24 h sin entrada gratuita.
- Ingesta: `entry[].messaging[]` (DMs; se descartan `is_echo`, borrados y no soportados) y `entry[].changes[]` con `field: 'comments'` (se descartan los del propio negocio). Los adjuntos llegan como **URL del CDN que caduca**: `mediaId` es esa URL y `fetchMedia` la descarga sin token.
- Errores: subcódigos propios (`2534022` fuera de ventana, `2534014` destinatario, `2534039/40` respuesta privada agotada o caducada). Tabla distinta de la de WhatsApp a propósito.
- Worker: un comentario abre o continúa un hilo `comment_thread` por publicación (`external_thread_id` = id del post) y contacto; no abre ventana. La API responde con `tipo: 'comment_reply'` (`modo: 'publica' | 'privada'`), que **no pasa por la ventana**: las reglas de una privada por comentario y siete días las aplica Meta y vuelven mapeadas.
- Conexión BYO: `POST /v1/canales/instagram {igUserId, accessToken, appSecret}`; se verifica con `GET /{ig-user-id}?fields=username` antes de guardar. El webhook resuelve la cuenta por `entry[].id` = `external_id`.

## Señal de producto: cómo lo hace Kommo (usuario, 2026-09-09)

El usuario mostró su Kommo real (Nippon Autoparts), con Facebook Messenger, Comentarios, Instagram, TikTok y WhatsApp instalados. Lo que confirmó de su experiencia usándolo:

- **Llega el comentario, y al responder el usuario lo recibe como mensaje privado** por Messenger/Instagram. O sea: en Kommo el camino principal de un comentario es **convertirlo en conversación privada**, no discutir en público. Es coherente con el objetivo: el comentario es una fuente de leads.
- **Que la respuesta privada falle es corriente y no es un problema**: mucha gente tiene los mensajes restringidos. Palabras del usuario: «algunos usuarios tienen una opción de que no le escriban, por lo cual si saliera error en ese mensaje no hay problema».

**Decisión que sale de aquí (PR-22):** en el compositor de un hilo de comentarios, `modo` es **`privada` por defecto** —también en la API, `z.enum([...]).default('privada')`— y «En público» es un botón aparte, porque la ve cualquiera. Cuando el privado se rechaza, la web **no lo trata como avería**: explica en tono normal que esa persona no acepta mensajes privados o que ya se le envió uno, y ofrece responder en el comentario.

## Revisión de conexión y comentarios (PR-39, 2026-09-14)

El usuario pidió «de pasada» revisar comentarios e Instagram. Salieron dos fallos que no daban ningún error:

1. **La web no tenía cómo conectar Instagram.** La API existía desde PR-19, pero Ajustes → Canales solo ofrecía «Conectar WhatsApp». Ahora hay asistente propio: token de usuario → lista de cuentas de Instagram vinculadas a páginas → elegir.
2. **Instagram se conectaba sordo, igual que le pasó a WhatsApp en PR-21.** Nada suscribía la página a los webhooks, y **sin la suscripción a `comments` los comentarios no llegan nunca**, por mucho que la ingesta los sepa leer. Ahora, al conectar con un token de usuario:
   - `GET /me/accounts` con `instagram_business_account{id,username}` encuentra la página de esa cuenta;
   - se guarda el **token de PÁGINA** (el que exige la API de mensajes), no el de usuario;
   - `POST /{page-id}/subscribed_apps?subscribed_fields=messages,comments` suscribe la página, y el resultado queda en `webhook_subscribed`, con el mismo aviso rojo «No recibe mensajes» que WhatsApp;
   - el id de la página se guarda en `provider_account_id`.

   Si el token ya era de página, `/me` es la página y se usa tal cual. Si no ve ninguna página (token de otro tipo), se hace lo de antes: verificar y guardar. Renovar el token repite el camino y suscribe lo que faltara.

**Permisos que hay que pedir** (según la referencia de webhooks de Instagram con inicio de sesión de Facebook): `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`. **Los webhooks de comentarios exigen Acceso Avanzado**: con acceso estándar solo llegan los de cuentas con rol en la app. Eso es App Review, igual que Messenger.

Los tokens de página nunca llegan a la web: `POST /v1/canales/instagram/descubrir` los quita antes de responder, y el alta los vuelve a pedir a Meta en el servidor.

**Comentarios de Facebook** (lo que Kommo llama «Comentarios») no existen todavía: llegan con el canal Messenger, que es el siguiente PR de canales.

## Aprendizajes verificados

Ninguno con tráfico real todavía: el adaptador está probado sin red (17 tests) y por HTTP con el sandbox y con un payload real firmado.
