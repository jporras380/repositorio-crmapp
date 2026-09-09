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

## Aprendizajes verificados

Ninguno con tráfico real todavía: el adaptador está probado sin red (17 tests) y por HTTP con el sandbox y con un payload real firmado.
