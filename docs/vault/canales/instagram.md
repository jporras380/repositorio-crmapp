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

## Aprendizajes verificados

Ninguno todavía.
