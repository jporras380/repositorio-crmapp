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
