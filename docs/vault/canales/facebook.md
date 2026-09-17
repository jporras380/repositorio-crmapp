---
estado: vivo
fecha: 2026-09-15
modulo: canales
tags: [canal, facebook, messenger, comentarios, meta]
---

# Canal — Facebook Messenger y comentarios de página

Prioridad 3 del encargo. Entró en PR-42 **dentro del contrato `ChannelAdapter`**: `core` no cambió, y la base solo amplió la lista de canales permitidos (migración 0024). Lo nuevo es un adaptador, una ingesta y el asistente de conexión.

## Qué dice Meta (documentación consultada el 2026-09-15)

- **Enviar:** `POST /{page-id}/messages` con `recipient.id` = PSID (id de la persona propio de la página), `messaging_type: 'RESPONSE'` y `message.text` o `message.attachment {type, payload.url}`. Responde `recipient_id` y `message_id`.
- **Ventana estándar de 24 h** desde la última interacción de la persona. Fuera de ella solo hay etiquetas de mensaje, que exigen permisos propios: **no se ofrecen**.
- **Webhook `object: 'page'`:** `entry[].id` es la página; `messaging[]` trae `sender.id`, `message.mid`, `text`, `attachments[].payload.url` e `is_echo`.
- **Comentarios:** campo `feed` con `item: 'comment'` y `verb: 'add'`, más `comment_id`, `post_id`, `parent_id`, `from {id, name}`, `message` y `created_time`. El `feed` trae también reacciones, publicaciones y ediciones: **solo se toma el comentario nuevo**.
- **Respuesta privada a un comentario:** `POST /{page-id}/messages` con `recipient.comment_id`. **Una sola por comentario y dentro de los 7 días.**
- **Respuesta pública:** `POST /{comment-id}/comments` con `message` (permiso `pages_manage_engagement`).
- **Suscripción:** `POST /{page-id}/subscribed_apps?subscribed_fields=messages,feed` con token de página. Hace falta `pages_manage_metadata`.

## Decisiones

**Se guarda el token de PÁGINA**, igual que en Instagram: el usuario pega su token de usuario, elige la página de la lista y el servidor lo cambia por el de la página. Los tokens de página nunca llegan a la web.

**Meta REEMPLAZA los campos suscritos en cada llamada.** Una página puede tener conectados a la vez su Instagram y su Facebook. Si conectar Facebook suscribiera solo `messages,feed`, **los comentarios de Instagram de esa página dejarían de llegar sin ningún error**. Por eso el servicio suscribe la unión de los campos de todos los canales de la cuenta que cuelgan de la página, con un test que lo fija.

**Messenger no manda el nombre de la persona** en el webhook, solo el PSID. La bandeja enseña «Usuario de Messenger» y el agente lo renombra desde la ficha ([[bandeja]] §Cambiar el nombre). Pedir el nombre a la User Profile API queda como mejora: exige otra llamada y otro permiso. Los comentarios sí traen `from.name`.

**Errores:** 190 → token inválido, 551 → persona no disponible, 4/17/32/613 → límite de tasa. **La tabla oficial de subcódigos devolvía error 500 al escribir esto**: no se mapearon subcódigos de memoria. El resto, incluido fuera de ventana, queda como rechazo no reintentable con el mensaje de Meta.

## Pendiente

- **Probarlo con una página real.** Hace falta un token de usuario con `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement` y `pages_manage_engagement`. Para clientes sin rol en la app, esos permisos requieren **Acceso Avanzado (App Review)**.
- En la app de Meta hay que configurar el producto **Webhooks → Page** con la URL `/webhooks/facebook`.
- Nombre de la persona por la User Profile API.
- Etiquetas de mensaje para escribir fuera de la ventana.

Relacionado: [[instagram]], [[whatsapp]], [[2026-09-14-embedded-signup]].

## «No tienes ninguna página» siendo mentira (PR-63, 2026-09-17)

El usuario asignó su página al usuario del sistema, generó un token y el asistente le dijo que no veía ninguna página. La página estaba ahí, delante.

### Dos causas, y las dos callaban

**1. `/me/accounts` es de tokens de USUARIO.** Con un token de usuario del sistema devuelve `data: []` y un **200** — «no tienes páginas» sin ningún error. Es el mismo borde que ya nos mordió con las WABA en PR-39, y la solución es la hermana: `GET /me/assigned_pages`, las páginas asignadas a ese usuario en el Business Manager.

Si la página asignada no trae `access_token`, se le pide a ella (`GET /{page-id}?fields=access_token`). Sin token de página no se puede suscribirla ni responder: devolverla a medias sería descubrirlo al enviar, delante de un cliente.

**2. Un token sin permisos de páginas también devuelve la lista vacía.** Comprobado contra Meta el 17/09 con el token real del proyecto: `/me/accounts` y `/me/assigned_pages` devuelven `data: []` y 200, sin decir que faltan `pages_show_list`, `pages_messaging` y `pages_read_engagement`.

Ahora, antes de decir «no tienes páginas», el CRM le pregunta al token por sus permisos (`debug_token`, que un token puede hacer sobre sí mismo) y, si faltan, **los nombra**: «Este token no tiene pages_show_list, pages_messaging, pages_read_engagement. Sin esos permisos Meta devuelve la lista vacía aunque administres alguna».

### Lo que NO es el problema

**El rol del usuario del sistema.** Employee basta si la página está asignada; pasar a Admin no cambia la lista. Lo que decide son las casillas marcadas **al generar el token**.

### Cómo comprobarlo en menos de 5 minutos

Ajustes → Canales → Conectar Facebook con un token sin permisos de páginas: sale el mensaje diciendo cuáles faltan, no un «no tienes páginas». Con los permisos y la página asignada, sale la página.

4 tests sin red con las respuestas que Meta da de verdad.
